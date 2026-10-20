import {
  FloatType,
  HalfFloatType,
  Matrix3,
  Matrix4,
  NearestFilter,
  NoToneMapping,
  RGBAFormat,
  RedIntegerFormat,
  RenderTarget,
  StorageTexture,
  UnsignedByteType,
  UnsignedIntType,
  Vector3,
  type Material,
  type Mesh,
  type Object3D,
  type PerspectiveCamera,
  type Texture,
  type WebGPURenderer,
} from 'three/webgpu'
import {
  diffuseColor,
  float,
  globalId,
  metalness,
  mrt,
  normalView,
  positionWorld,
  roughness,
  smoothstep,
  texture,
  textureStore,
  uniform,
  vec4,
} from 'three/tsl'
import { wgslTagFn } from 'three-mesh-bvh/src/webgpu/nodes/WGSLTagFnNode.js'
import { ComputeKernel } from 'three-gpu-pathtracer/src/webgpu/compute/ComputeKernel.js'
import { smoothstep as smooth } from '../lib/visuals'
import { historyCapacity, historyDistance, type HistoryPose } from './historyCache'

/**
 * Sample reuse between camera positions.
 *
 * A path tracer refining one view has already computed the light leaving every surface it sees.
 * For matte surfaces that light does not depend on where it is seen from, so when the camera
 * moves, most of the converged image is still correct, just elsewhere on screen. Instead of
 * starting the new view from zero samples, its accumulation is seeded with the old one,
 * reprojected through both views' rasterized geometry:
 *
 * - each pixel of the new view looks up the same surface point in the old view, and keeps the old
 *   result only if the point was visible there (position and normal agree);
 * - how many of the old samples it inherits scales with how view-independent the surface is:
 *   none for glass, mirrors, metals, and clear coats; most for rough dielectrics, less the further
 *   the viewing angle turned;
 * - every pixel still takes at least a quarter of its samples fresh from the new view, so edges
 *   and anything the estimate got wrong converge to the true image.
 *
 * The tracer gives no new samples to pixels that already hold enough, so its work goes to what
 * the old view did not see (disocclusions, the screen edge, glossy surfaces) first.
 */

/** At most this share of a pixel's target samples may come from an earlier view. */
export const HISTORY_SHARE = 0.75
/** Below this roughness a surface's reflection moves with the eye and is not reused. */
const GLOSSY = 0.2
/** Above this roughness a dielectric reflects so diffusely that it is reused in full. */
const MATTE = 0.7

/** Layout of the tracer's sample count texels (three-gpu-pathtracer/src/webgpu/constants.js). */
const SAMPLE_DISPATCHED_FLAG = 0x40000000
const SAMPLE_COUNT_MASK = 0x3fffffff

type Record_ = Record<string, unknown>
const isLit = (material: Material) => {
  const m = material as Material & {
    isMeshStandardMaterial?: boolean
    isMeshStandardNodeMaterial?: boolean
  }
  return Boolean(m.isMeshStandardMaterial || m.isMeshStandardNodeMaterial)
}

/**
 * How much of a material's traced appearance survives a change of viewpoint, from what the
 * rasterized G-buffer cannot show: whether the tracer sees it at all, transmission, clear coat,
 * and path-trace stand-in properties. Per-texel roughness and metalness are applied on the GPU.
 */
export function materialHistoryWeight(material: Material) {
  const override = material.userData.pathTrace as Record_ | undefined
  // Unlit meshes are hidden from the tracer, which sees whatever lies behind them.
  if (!override && !isLit(material)) return 0
  const value = (key: string, fallback: number) => {
    const v = override?.[key] ?? (material as unknown as Record_)[key]
    return typeof v === 'number' ? v : fallback
  }
  if (value('transmission', 0) > 0) return 0
  let weight = 1 - value('clearcoat', 0)
  // Stand-ins replace what the raster pass reports (a raster mirror is unlit, its stand-in metal).
  if (override && ('metalness' in override || 'roughness' in override))
    weight *= (1 - value('metalness', 0)) * smooth(GLOSSY, MATTE, value('roughness', 1))
  return Math.max(0, Math.min(1, weight))
}

/** Per-mesh history weights for one view, honoring objects the tracer excludes. */
export function historyWeights(scene: Object3D) {
  const weights = new WeakMap<Object3D, number>()
  const visit = (object: Object3D, excluded: boolean) => {
    const hidden = excluded || object.userData.pathTrace === false
    const mesh = object as Mesh
    if (mesh.isMesh) {
      const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material]
      weights.set(object, hidden ? 0 : Math.min(...materials.map(materialHistoryWeight)))
    }
    for (const child of object.children) visit(child, hidden)
  }
  visit(scene, false)
  return weights
}

/**
 * Rasterized per-pixel data of one traced view, rendered once when tracing starts: albedo and
 * view-space normals (also the denoiser's guides) and world position with the history weight.
 * Multisampled like the traced image, whose pixels average a jittered footprint.
 */
export class GBuffer {
  readonly target = new RenderTarget(1, 1, {
    count: 3,
    type: UnsignedByteType,
    minFilter: NearestFilter,
    magFilter: NearestFilter,
    samples: 4,
  })
  /** The view's camera: position, world-to-clip, and view-to-world rotation. */
  readonly position = new Vector3()
  readonly viewProjection = new Matrix4()
  readonly viewToWorld = new Matrix3()
  /** World-space size of a pixel one unit in front of the camera. */
  pixelAngle = 0
  private readonly mrt
  private weights = new WeakMap<Object3D, number>()

  constructor() {
    const [albedo, normal, history] = this.target.textures
    albedo.name = 'output'
    normal.name = 'normal'
    history.name = 'history'
    history.type = HalfFloatType
    const objectWeight = uniform(0).onObjectUpdate(({ object }) =>
      object ? (this.weights.get(object) ?? 0) : 0,
    )
    this.mrt = mrt({
      output: diffuseColor,
      normal: vec4(normalView.mul(0.5).add(0.5), 1),
      history: vec4(
        positionWorld,
        objectWeight.mul(float(1).sub(metalness)).mul(smoothstep(GLOSSY, MATTE, roughness)),
      ),
    })
  }

  get albedo() {
    return this.target.textures[0]
  }
  get normal() {
    return this.target.textures[1]
  }
  get history() {
    return this.target.textures[2]
  }

  render(
    renderer: WebGPURenderer,
    scene: Object3D,
    camera: PerspectiveCamera,
    w: number,
    h: number,
  ) {
    if (this.target.width !== w || this.target.height !== h) this.target.setSize(w, h)
    this.weights = historyWeights(scene)
    camera.updateMatrixWorld()
    this.position.setFromMatrixPosition(camera.matrixWorld)
    this.viewProjection.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse)
    this.viewToWorld.setFromMatrix4(camera.matrixWorld)
    this.pixelAngle = (2 * Math.tan((camera.fov * Math.PI) / 360)) / h
    const target = renderer.getRenderTarget()
    const toneMapping = renderer.toneMapping
    const previousMRT = renderer.getMRT()
    const clearAlpha = renderer.getClearAlpha()
    // Nothing drawn means nothing to reuse: weight (alpha) 0.
    renderer.setClearAlpha(0)
    renderer.toneMapping = NoToneMapping
    renderer.setRenderTarget(this.target)
    renderer.setMRT(this.mrt)
    renderer.render(scene, camera)
    renderer.setMRT(previousMRT)
    renderer.setRenderTarget(target)
    renderer.toneMapping = toneMapping
    renderer.setClearAlpha(clearAlpha)
  }

  dispose() {
    this.target.dispose()
  }
}

function storageTexture(format: number, type: number) {
  const t = new StorageTexture(1, 1)
  t.format = format as typeof t.format
  t.type = type as typeof t.type
  t.generateMipmaps = false
  t.minFilter = t.magFilter = NearestFilter
  return t
}

/**
 * Seeds a path tracer's accumulation for a new view from an earlier one. Writes the tracer's color
 * target and its sample counts, so call it right after the tracer resets.
 */
class ReprojectKernel extends ComputeKernel {
  declare outputTarget: Texture
  declare sampleCountTarget: Texture
  declare historyColor: Texture
  declare historyCounts: Texture
  declare historyGeometry: Texture
  declare historyNormal: Texture
  declare historyAlbedo: Texture
  declare currentGeometry: Texture
  declare currentNormal: Texture
  declare currentAlbedo: Texture
  declare previousViewProjection: Matrix4
  declare previousViewToWorld: Matrix3
  declare currentViewToWorld: Matrix3
  declare previousPosition: Vector3
  declare currentPosition: Vector3
  declare previousPixelAngle: number
  declare currentPixelAngle: number
  declare cap: number

  constructor() {
    const params = {
      globalId,
      // Devices may allow as few as four storage textures per stage: only the outputs use them.
      outputTarget: textureStore(storageTexture(RGBAFormat, FloatType)).toWriteOnly(),
      sampleCountTarget: textureStore(
        storageTexture(RedIntegerFormat, UnsignedIntType),
      ).toWriteOnly(),
      historyColor: texture(storageTexture(RGBAFormat, FloatType)),
      historyCounts: texture(storageTexture(RedIntegerFormat, UnsignedIntType)),
      historyGeometry: texture(storageTexture(RGBAFormat, HalfFloatType)),
      historyNormal: texture(storageTexture(RGBAFormat, UnsignedByteType)),
      historyAlbedo: texture(storageTexture(RGBAFormat, UnsignedByteType)),
      currentGeometry: texture(storageTexture(RGBAFormat, HalfFloatType)),
      currentNormal: texture(storageTexture(RGBAFormat, UnsignedByteType)),
      currentAlbedo: texture(storageTexture(RGBAFormat, UnsignedByteType)),
      previousViewProjection: uniform(new Matrix4()),
      previousViewToWorld: uniform(new Matrix3()),
      currentViewToWorld: uniform(new Matrix3()),
      previousPosition: uniform(new Vector3()),
      currentPosition: uniform(new Vector3()),
      previousPixelAngle: uniform(0),
      currentPixelAngle: uniform(0),
      cap: uniform(0, 'uint'),
    }

    // Pixel (x, y) of the tracer counts rows bottom up (its camera rays map y to NDC -1..1), while
    // color targets and rasterized images store rows top down.
    //
    // What is carried over is the light arriving at the surface (color over albedo, softened so
    // near-black albedo cannot blow it up), re-multiplied by the new view's own albedo: texture
    // detail comes from the sharp raster, never from resampled history.
    const fn = wgslTagFn /* wgsl */ `
      fn compute(
        globalId: vec3u,
        previousViewProjection: mat4x4f,
        previousViewToWorld: mat3x3f,
        currentViewToWorld: mat3x3f,
        previousPosition: vec3f,
        currentPosition: vec3f,
        previousPixelAngle: f32,
        currentPixelAngle: f32,
        cap: u32,
      ) -> void {

        const ALBEDO_FLOOR = 0.02;
        const EDGE_CONTRAST = 0.25;
        let size = textureDimensions( ${params.outputTarget} );
        if ( globalId.x >= size.x || globalId.y >= size.y ) {
          return;
        }
        let row = vec2u( globalId.x, size.y - 1u - globalId.y );

        var color = vec4f( 0.0 );
        var count = 0u;
        let current = textureLoad( ${params.currentGeometry}, row, 0 );
        let weight = clamp( current.w, 0.0, 1.0 );
        if ( weight > 0.01 ) {

          let point = current.xyz;
          let normal = normalize( currentViewToWorld * ( textureLoad( ${params.currentNormal}, row, 0 ).xyz * 2.0 - 1.0 ) );
          let clip = previousViewProjection * vec4f( point, 1.0 );
          if ( clip.w > 0.0 ) {

            // continuous pixel coordinates in the old view, pixel centers on integers
            let at = ( clip.xy / clip.w * 0.5 + 0.5 ) * vec2f( size ) - 0.5;
            let base = vec2i( floor( at ) );
            let f = at - vec2f( base );
            let distance = length( point - currentPosition );
            let previousDistance = length( point - previousPosition );
            // neighbouring pixels of the same surface differ by about a pixel's footprint, more on
            // surfaces seen edge-on; half floats add ~0.1% of the coordinates
            let facing = max( abs( dot( normal, ( point - currentPosition ) / distance ) ), 0.1 );
            let footprint = max( distance * currentPixelAngle, previousDistance * previousPixelAngle );
            let tolerance = 1.5 * footprint / facing + 0.002 * length( point ) + 0.01;

            var total = 0.0;
            var samples = 0.0;
            var sum = vec4f( 0.0 );
            var darkest = 1e30;
            var brightest = 0.0;
            for ( var i = 0; i < 4; i ++ ) {

              let offset = vec2i( i & 1, i >> 1 );
              let pixel = base + offset;
              if ( pixel.x < 0 || pixel.y < 0 || pixel.x >= i32( size.x ) || pixel.y >= i32( size.y ) ) {
                continue;
              }
              let bilinear = select( 1.0 - f.x, f.x, offset.x == 1 ) * select( 1.0 - f.y, f.y, offset.y == 1 );
              let pixelRow = vec2i( pixel.x, i32( size.y ) - 1 - pixel.y );
              let seen = textureLoad( ${params.historyGeometry}, pixelRow, 0 );
              if ( bilinear <= 0.0 || seen.w <= 0.01 || length( seen.xyz - point ) > tolerance ) {
                continue;
              }
              let seenNormal = normalize( previousViewToWorld * ( textureLoad( ${params.historyNormal}, pixelRow, 0 ).xyz * 2.0 - 1.0 ) );
              if ( dot( seenNormal, normal ) < 0.8 ) {
                continue;
              }
              let n = f32( textureLoad( ${params.historyCounts}, pixel, 0 ).r & ${SAMPLE_COUNT_MASK}u );
              if ( n <= 0.0 ) {
                continue;
              }
              let seenColor = textureLoad( ${params.historyColor}, pixelRow, 0 );
              let light = seenColor.rgb / ( textureLoad( ${params.historyAlbedo}, pixelRow, 0 ).rgb + ALBEDO_FLOOR );
              let level = dot( light, vec3f( 0.2126, 0.7152, 0.0722 ) );
              darkest = min( darkest, level );
              brightest = max( brightest, level );
              total += bilinear;
              samples += bilinear * n;
              sum += bilinear * vec4f( light, seenColor.a );
            }

            if ( total > 0.6 ) {

              // the further the eye turned around the point, the less a glossier surface keeps
              let turn = dot( normalize( point - previousPosition ), normalize( point - currentPosition ) );
              let allowed = mix( 0.995, 0.5, weight );
              let angular = clamp( ( turn - allowed ) / ( 1.0 - allowed ), 0.0, 1.0 );
              // magnified history is blurrier than the new view: inherit in proportion to detail
              let scale = ( distance * currentPixelAngle ) / max( previousDistance * previousPixelAngle, 1e-6 );
              let detail = clamp( scale * scale, 0.0, 1.0 );
              // across a shadow or light edge the interpolated light is a blur: trust it less
              let light = sum / total;
              let contrast = ( brightest - darkest ) / ( dot( light.rgb, vec3f( 0.2126, 0.7152, 0.0722 ) ) + 1e-3 );
              let edge = clamp( EDGE_CONTRAST / max( contrast, 1e-4 ), 0.0, 1.0 );
              count = min( u32( samples / total * weight * angular * detail * edge ), cap );
              if ( count > 0u ) {
                let albedo = textureLoad( ${params.currentAlbedo}, row, 0 ).rgb + ALBEDO_FLOOR;
                color = vec4f( light.rgb * albedo, light.a );
              }

            }

          }

        }

        // the tracer copies this into its other color target before its first pass
        textureStore( ${params.outputTarget}, row, color );
        textureStore( ${params.sampleCountTarget}, globalId.xy, vec4u( ${SAMPLE_DISPATCHED_FLAG}u | count ) );

      }
    `

    super(fn(params))
    this.defineUniformAccessors(params)
  }
}

type TracerTargets = {
  outputTarget: StorageTexture
  sampleCountTarget: StorageTexture
}

/**
 * The last traced view, kept so the next view can start from it: its accumulation, sample
 * counts, positions, normals, and albedo, copied aside (36 bytes a pixel) when tracing stops.
 */
export class ViewHistory {
  private readonly color = storageTexture(RGBAFormat, FloatType)
  private readonly counts = storageTexture(RedIntegerFormat, UnsignedIntType)
  private readonly geometry = storageTexture(RGBAFormat, HalfFloatType)
  private readonly normal = storageTexture(RGBAFormat, UnsignedByteType)
  private readonly albedo = storageTexture(RGBAFormat, UnsignedByteType)
  private readonly view = {
    position: new Vector3(),
    viewProjection: new Matrix4(),
    viewToWorld: new Matrix3(),
    pixelAngle: 0,
  }
  private readonly textures = [this.color, this.counts, this.geometry, this.normal, this.albedo]
  private kernel: ReprojectKernel | null = null
  /** Scene signature the stored view belongs to; -1 when there is none. */
  signature = -1

  /** Keeps a traced view: call before the tracer resets for the next one. */
  store(renderer: WebGPURenderer, tracer: TracerTargets, gbuffer: GBuffer, signature: number) {
    const { width, height } = tracer.outputTarget.image as { width: number; height: number }
    for (const t of this.textures) {
      const size = t.image as { width: number; height: number }
      if (size.width !== width || size.height !== height) t.setSize(width, height, 1)
    }
    renderer.copyTextureToTexture(tracer.outputTarget, this.color)
    renderer.copyTextureToTexture(tracer.sampleCountTarget, this.counts)
    renderer.copyTextureToTexture(gbuffer.history, this.geometry)
    renderer.copyTextureToTexture(gbuffer.normal, this.normal)
    renderer.copyTextureToTexture(gbuffer.albedo, this.albedo)
    this.view.position.copy(gbuffer.position)
    this.view.viewProjection.copy(gbuffer.viewProjection)
    this.view.viewToWorld.copy(gbuffer.viewToWorld)
    this.view.pixelAngle = gbuffer.pixelAngle
    this.signature = signature
  }

  /**
   * Seeds the tracer's freshly reset accumulation for the view in `gbuffer`. Returns false (and
   * leaves the tracer untouched) when there is no stored view of the same scene and size.
   */
  seed(
    renderer: WebGPURenderer,
    tracer: TracerTargets,
    gbuffer: GBuffer,
    signature: number,
    target: number,
  ) {
    if (signature !== this.signature) return false
    const { width, height } = tracer.outputTarget.image as { width: number; height: number }
    const stored = this.color.image as { width: number; height: number }
    if (stored.width !== width || stored.height !== height) return false
    const k = (this.kernel ??= new ReprojectKernel().setWorkgroupSize(8, 8, 1) as ReprojectKernel)
    k.outputTarget = tracer.outputTarget
    k.sampleCountTarget = tracer.sampleCountTarget
    k.historyColor = this.color
    k.historyCounts = this.counts
    k.historyGeometry = this.geometry
    k.historyNormal = this.normal
    k.historyAlbedo = this.albedo
    k.currentGeometry = gbuffer.history
    k.currentNormal = gbuffer.normal
    k.currentAlbedo = gbuffer.albedo
    k.previousViewProjection.copy(this.view.viewProjection)
    k.previousViewToWorld.copy(this.view.viewToWorld)
    k.currentViewToWorld.copy(gbuffer.viewToWorld)
    k.previousPosition.copy(this.view.position)
    k.currentPosition.copy(gbuffer.position)
    k.previousPixelAngle = this.view.pixelAngle
    k.currentPixelAngle = gbuffer.pixelAngle
    k.cap = Math.floor(target * HISTORY_SHARE)
    renderer.compute(k.kernel, k.getDispatchSize(width, height, 1))
    return true
  }

  clear() {
    this.signature = -1
  }

  dispose() {
    for (const t of this.textures) t.dispose()
    this.kernel?.dispose()
  }
}

/** Bounded orbit memory. One best view seeds each frame, never sums correlated histories. */
export class MultiViewHistory {
  private entries: { history: ViewHistory; pose: HistoryPose; used: number }[] = []
  private clock = 0
  private signature = -1
  private size = ''

  private pose(gbuffer: GBuffer): HistoryPose {
    return {
      position: gbuffer.position.toArray(),
      direction: gbuffer.viewToWorld.elements.slice(6, 9),
    }
  }

  store(renderer: WebGPURenderer, tracer: TracerTargets, gbuffer: GBuffer, signature: number) {
    const { width, height } = tracer.outputTarget.image as { width: number; height: number }
    const size = `${width}:${height}`
    if (this.signature !== signature || this.size !== size) this.clear()
    this.signature = signature
    this.size = size
    const capacity = historyCapacity(width, height)
    if (!capacity) return
    const pose = this.pose(gbuffer)
    let entry = this.entries.find((entry) => historyDistance(entry.pose, pose) < 0.025)
    if (!entry && this.entries.length >= capacity)
      entry = this.entries.reduce((oldest, item) => (item.used < oldest.used ? item : oldest))
    if (!entry) {
      entry = { history: new ViewHistory(), pose, used: 0 }
      this.entries.push(entry)
    }
    entry.history.store(renderer, tracer, gbuffer, signature)
    entry.pose = pose
    entry.used = ++this.clock
  }

  seed(
    renderer: WebGPURenderer,
    tracer: TracerTargets,
    gbuffer: GBuffer,
    signature: number,
    target: number,
  ) {
    if (signature !== this.signature || !this.entries.length) return false
    const pose = this.pose(gbuffer)
    const entry = this.entries.reduce((best, item) =>
      historyDistance(item.pose, pose) < historyDistance(best.pose, pose) ? item : best,
    )
    const seeded = entry.history.seed(renderer, tracer, gbuffer, signature, target)
    if (seeded) entry.used = ++this.clock
    return seeded
  }

  clear() {
    for (const entry of this.entries) entry.history.dispose()
    this.entries = []
    this.signature = -1
    this.size = ''
  }

  dispose() {
    this.clear()
  }
}

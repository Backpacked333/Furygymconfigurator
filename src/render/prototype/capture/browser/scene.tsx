/* eslint-disable react-refresh/only-export-components -- Single-use CLI worker, never an HMR/customer entry. */
import { Component, useEffect, type ReactNode } from 'react'
import { createRoot, extend, unmountComponentAtNode, useFrame } from '@react-three/fiber'
import * as THREE from 'three/webgpu'
import type { Material, Mesh, Texture, WebGLRenderer } from 'three'
import { Atmosphere } from '../../../../components/Atmosphere'
import { InteriorProbe, SiteProbe } from '../../../../components/InteriorProbe'
import { Landscape } from '../../../../components/Landscape'
import { StudioModel } from '../../../../components/StudioModel'
import { resolvePrivateThreeSceneInput } from '../../privateScene'
import { exposureAt } from '../../../../lib/visuals'
import { productHeight, type Config } from '../../../../lib/config'
import {
  materialLoaded,
  onMaterialsChanged,
  setMaxAnisotropy,
  whenMaterialLoaded,
} from '../../../materials'
import { createPipeline } from '../../../pipeline'
import { backendOf, beginFrame, createRenderer } from '../../../renderer'
import {
  CAPTURE_EFFECTS,
  CaptureContractError,
  captureCameraSchema,
  inspectDecodedPixels,
  parseCaptureRuntime,
  type CaptureJob,
  type CaptureCamera,
  type CaptureRuntime,
} from '../contract'
import { SettleGate, workerFailureDiagnostic, type CaptureScope, type SceneDriver } from './control'
import { guardResources } from './resources'

extend({
  Group: THREE.Group,
  Mesh: THREE.Mesh,
  InstancedMesh: THREE.InstancedMesh,
  PlaneGeometry: THREE.PlaneGeometry,
  CircleGeometry: THREE.CircleGeometry,
  MeshStandardMaterial: THREE.MeshStandardMaterial,
  DirectionalLight: THREE.DirectionalLight,
  SpotLight: THREE.SpotLight,
  PointLight: THREE.PointLight,
  RectAreaLight: THREE.RectAreaLight,
})

/** No Canvas DOM wrapper, app state, controls, exporters, stills or auto-render loop. */
export function CaptureAssembly({
  config,
  view,
}: {
  config: Config
  view: 'interior' | 'exterior'
}) {
  return (
    <>
      <Atmosphere config={config} quality="lite" view={view} />
      <Landscape config={config} quality="lite" />
      <StudioModel config={config} quality="lite" />
      <InteriorProbe config={config} quality="lite" />
      <SiteProbe config={config} quality="lite" />
      <ManualFrames />
    </>
  )
}
function ManualFrames() {
  useFrame(() => {}, 1) // positive priority disables Fiber's implicit gl.render
  return null
}
function CommitSignal({ ready }: { ready: () => void }) {
  useEffect(ready, [ready])
  return null
}
class SceneBoundary extends Component<
  { children: ReactNode; failed: () => void },
  { failed: boolean }
> {
  state = { failed: false }
  static getDerivedStateFromError() {
    return { failed: true }
  }
  componentDidCatch(error: unknown) {
    console.error(`[fury-capture-failure:${workerFailureDiagnostic(error)}]`)
    this.props.failed()
  }
  render() {
    return this.state.failed ? null : this.props.children
  }
}

/** Track resources from the main scene AND the otherwise private PMREM sky capture scenes. */
class SceneResources {
  private resources = new Map<{ dispose(): void }, boolean>()
  add(resource: {
    dispose(): void
    addEventListener?: (type: 'dispose', listener: () => void) => void
  }) {
    if (this.resources.has(resource)) return
    this.resources.set(resource, false)
    resource.addEventListener?.('dispose', () => this.resources.set(resource, true))
  }
  scene(scene: THREE.Scene) {
    scene.traverse((object) => {
      const mesh = object as Mesh
      if (mesh.geometry) this.add(mesh.geometry)
      for (const material of mesh.material
        ? Array.isArray(mesh.material)
          ? mesh.material
          : [mesh.material]
        : []) {
        this.add(material)
        for (const value of Object.values(material))
          if ((value as Texture | null)?.isTexture) this.add(value as Texture)
      }
    })
  }
  dispose() {
    for (const [resource, disposed] of this.resources) if (!disposed) resource.dispose()
    this.resources.clear()
  }
}

/** Observe actual successful authored PMREM passes; do not replace them with stand-ins. */
function observeProbes(
  scope: CaptureScope,
  gate: SettleGate,
  resources: SceneResources,
  config: Config,
) {
  const original = THREE.PMREMGenerator.prototype.fromScene
  THREE.PMREMGenerator.prototype.fromScene = function (...args: Parameters<typeof original>) {
    scope.check()
    resources.scene(args[0])
    const result = original.apply(this, args)
    resources.add(result)
    const position = args[4]?.position
    const now = performance.now()
    if (!position && args[1] === 0 && args[2] === 0.5 && args[3] === 2000) gate.capture('sky', now)
    else if (position?.x === 0 && position.y === 5 && position.z === 0)
      gate.capture('environment', now)
    else if (position?.x === 0 && position.y === productHeight(config) * 0.52 && position.z === 0.3)
      gate.capture('interior', now)
    else if (position?.x === 0 && position.y === productHeight(config) * 0.5 && position.z === 6)
      gate.capture('site', now)
    else throw new CaptureContractError('scene-failed', 'Unexpected probe capture.')
    return result
  }
  scope.own(() => {
    THREE.PMREMGenerator.prototype.fromScene = original
  })
}

/** Inspect the mounted camera, not only the echoed request. Math-only and testable without a GPU. */
export function assertMountedCamera(
  camera: THREE.PerspectiveCamera,
  pose: CaptureCamera,
  aspect: number,
) {
  const expected = new THREE.PerspectiveCamera(pose.fov, aspect, pose.near, pose.far)
  expected.position.set(...pose.position)
  expected.up.set(...pose.up)
  expected.lookAt(...pose.target)
  expected.updateMatrixWorld()
  expected.updateProjectionMatrix()
  camera.updateMatrixWorld()
  if (
    camera.fov !== pose.fov ||
    camera.near !== pose.near ||
    camera.far !== pose.far ||
    camera.aspect !== aspect ||
    camera.zoom !== 1 ||
    !camera.position.equals(expected.position) ||
    !camera.up.equals(expected.up) ||
    camera.matrixWorld.elements.some(
      (value, i) => Math.abs(value - expected.matrixWorld.elements[i]) > 1e-9,
    ) ||
    camera.projectionMatrix.elements.some(
      (value, i) => Math.abs(value - expected.projectionMatrix.elements[i]) > 1e-9,
    )
  )
    throw new CaptureContractError(
      'identity-mismatch',
      'Mounted camera differs from the fixed gallery pose.',
    )
}

function sceneMaterials(scene: THREE.Scene) {
  const result = new Set<Material>()
  scene.traverse((object) => {
    const material = (object as Mesh).material
    if (material) for (const m of Array.isArray(material) ? material : [material]) result.add(m)
  })
  return [...result]
}

function cleanNote(value: string) {
  return (
    Array.from(value, (char) =>
      char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127 ? ' ' : char,
    )
      .join('')
      .slice(0, 512) || 'unavailable'
  )
}
export function effectReceipt(config: Config): CaptureRuntime['effects'] {
  const details: Partial<
    Record<
      (typeof CAPTURE_EFFECTS)[number],
      { state: 'enabled' | 'approximate' | 'not-applicable'; detail: string }
    >
  > = {
    architecture: {
      state: 'enabled',
      detail:
        'Authored UNIT_LISTS via StudioModel; strict v4 projection and selected door pose; draft arrangements and access holds remain.',
    },
    'fixed-equipment': {
      state: 'enabled',
      detail: 'Authored Equipment geometry and fixed arrangement only; no placement editing.',
    },
    'material-textures': {
      state: 'enabled',
      detail:
        'Real browser node materials; all requested scans decoded and all library materials loaded. Asset rights and color calibration remain draft.',
    },
    'console-canvas': {
      state: config.items.some((item) => ['airbike', 'bike', 'treadmill'].includes(item.sku))
        ? 'approximate'
        : 'not-applicable',
      detail:
        'Authored equipment canvas pixels when present; system sans-serif, not font-calibrated or manufacturer-approved displays.',
    },
    'signature-canvas': {
      state: config.family === 'studio' ? 'approximate' : 'not-applicable',
      detail:
        'Authored Studio signature canvas when present; system sans-serif metrics are host-dependent.',
    },
    environment: {
      state: 'enabled',
      detail:
        'Authored Atmosphere and Landscape; procedural sky PMREM plus two observed site captures. Lite thins foliage, reduces probe/shadow resolution and omits grass shadowing; no parity claim.',
    },
    'fixture-lighting': {
      state: 'enabled',
      detail:
        'Authored InteriorLights and site fixtures; selected draft look and camera-group exposure. Lite fixture shadows/photometry are unqualified.',
    },
    'interior-probe': {
      state: 'enabled',
      detail:
        'Four observed room PMREM captures after last texture change; 64px cube faces in Lite. Not traced GI.',
    },
    'site-probe': {
      state: 'enabled',
      detail:
        'Observed local exterior PMREM capture after last texture change; 128px cube faces and authored parallax approximation.',
    },
    'site-light-field': {
      state: 'approximate',
      detail:
        'Observed authored module-worker field completion before settle; one-bounce scalar SH grid, not spectral or traced site lighting.',
    },
    'thin-glass': {
      state: 'approximate',
      detail:
        'Authored TSL Fresnel blended thin panes and probe reflections; not physically traced/refraction-qualified glazing.',
    },
    mirror: {
      state: config.mirror ? 'approximate' : 'not-applicable',
      detail:
        'Lite polished metal approximation; no planar/ray-traced reflection. Existing mirror material uses scene environment, not a dedicated observed room env binding.',
    },
    msaa: {
      state: 'enabled',
      detail:
        'Authored Lite pipeline requests 4x MSAA; AgX, sRGB and dither. No temporal AA, motion blur or laptop-performance claim.',
    },
  }
  return CAPTURE_EFFECTS.map((id) => ({
    id,
    ...(details[id] ?? {
      state: 'omitted' as const,
      detail:
        'Not implemented by the fixed Lite raster profile; no fallback or strict-reference substitution.',
    }),
  }))
}

function runtimeOf(renderer: THREE.WebGPURenderer, config: Config): CaptureRuntime {
  const backend = backendOf(renderer)
  let adapter = 'unavailable'
  if (backend === 'webgl2') {
    const gl = renderer.getContext() as WebGL2RenderingContext
    // Lite's authored pass is RGBA16F, not the default canvas framebuffer. MAX_SAMPLES
    // alone can pass even if that actual HDR format silently cannot allocate four samples.
    const counts = gl.getInternalformatParameter(
      gl.RENDERBUFFER,
      gl.RGBA16F,
      gl.SAMPLES,
    ) as Int32Array | null
    if (gl.getParameter(gl.MAX_SAMPLES) < 4 || !counts || !Array.from(counts).includes(4))
      throw new CaptureContractError('unsupported-renderer', '4x HDR MSAA is unavailable.')
    const extension = gl.getExtension('WEBGL_debug_renderer_info')
    adapter = extension
      ? String(gl.getParameter(extension.UNMASKED_RENDERER_WEBGL))
      : String(gl.getParameter(gl.RENDERER))
  } else {
    const info = (renderer.backend as unknown as { adapter?: { info?: Record<string, unknown> } })
      .adapter?.info
    if (info)
      adapter =
        ['vendor', 'architecture', 'device', 'description']
          .map((key) => String(info[key] ?? ''))
          .join(' ')
          .trim() || adapter
  }
  const userAgent = cleanNote(navigator.userAgent)
  return parseCaptureRuntime({
    backend,
    // Never infer hardware from a launch flag or from the absence of a software substring.
    acceleration: /swiftshader|llvmpipe|lavapipe|software|microsoft basic render/i.test(adapter)
      ? 'software'
      : 'unknown',
    adapter: cleanNote(adapter),
    userAgent,
    browserVersion:
      userAgent.match(/(?:HeadlessChrome|Chrome)\/[\d.]+/)?.[0] ?? 'unavailable in user agent',
    effects: effectReceipt(config),
  })
}

async function encodedPixels(blob: Blob, job: CaptureJob, scope: CaptureScope) {
  if (blob.type !== 'image/png' || blob.size === 0 || blob.size > job.profile.maxPngBytes)
    throw new CaptureContractError('invalid-artifact', 'Invalid encoded PNG size/type.')
  const bitmap = await scope.wait(
    createImageBitmap(blob).then((image) => {
      scope.own(() => image.close())
      return image
    }),
  )
  const decoded = document.createElement('canvas')
  scope.own(() => {
    decoded.width = decoded.height = 0
  })
  decoded.width = bitmap.width
  decoded.height = bitmap.height
  const context = decoded.getContext('2d', { willReadFrequently: true })
  if (!context)
    throw new CaptureContractError('unsupported-renderer', 'PNG pixel readback unavailable.')
  context.drawImage(bitmap, 0, 0)
  inspectDecodedPixels(
    job.profile,
    bitmap.width,
    bitmap.height,
    context.getImageData(0, 0, bitmap.width, bitmap.height).data,
  )
  scope.check()
  bitmap.close()
  decoded.width = decoded.height = 0
  const bytes = new Uint8Array(await scope.wait(blob.arrayBuffer()))
  scope.check()
  let binary = ''
  for (let offset = 0; offset < bytes.length; offset += 16384)
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 16384))
  return btoa(binary)
}

export const renderScene: SceneDriver = async (job, scope, progress) => {
  if (THREE.REVISION !== job.build.threeRevision)
    throw new CaptureContractError(
      'identity-mismatch',
      'Actual Three revision differs from bootstrap.',
    )
  if (
    typeof createImageBitmap !== 'function' ||
    typeof Worker !== 'function' ||
    !document.createElement('canvas').getContext('2d')
  )
    throw new CaptureContractError(
      'unsupported-renderer',
      'Required local browser APIs unavailable.',
    )
  const gate = new SettleGate(job.profile.quietMs)
  const network = guardResources(scope, gate)
  const input = resolvePrivateThreeSceneInput(job.request.design)
  const { view } = input
  const config: Config = { ...input.config, items: input.config.items.map((item) => ({ ...item })) }
  const pose = captureCameraSchema.parse(input.camera)
  if (job.profile.width !== input.profile.width || job.profile.height !== input.profile.height)
    throw new CaptureContractError('identity-mismatch', 'Prepared scene aspect/profile mismatch.')
  const canvas = document.createElement('canvas')
  canvas.width = job.profile.width
  canvas.height = job.profile.height
  document.body.append(canvas)
  scope.own(() => {
    canvas.remove()
    canvas.width = canvas.height = 0
  })
  let renderer: THREE.WebGPURenderer
  try {
    renderer = await scope.wait(
      createRenderer(canvas).then((value) => {
        scope.own(() => value.dispose())
        return value
      }),
    )
  } catch (error) {
    if (error instanceof CaptureContractError) throw error
    throw new CaptureContractError(
      'unsupported-renderer',
      'Graphics backend initialization failed.',
    )
  }
  network.check()
  const runtime = runtimeOf(renderer, config)
  // Fixed, schema-checked diagnostic survives later scene failure; not a successful receipt.
  console.info('fury-capture-runtime', JSON.stringify(runtime))
  let sceneFailure: string | undefined
  renderer.onDeviceLost = () => {
    sceneFailure ??= 'Private graphics device was lost.'
  }
  renderer.debug.checkShaderErrors = true
  renderer.debug.onShaderError = () => {
    sceneFailure ??= 'Private shader compilation failed.'
  }
  const device = (renderer.backend as unknown as { device?: EventTarget }).device
  const lost = () => {
    sceneFailure ??= 'Private graphics device was lost.'
  }
  device?.addEventListener('uncapturederror', lost)
  scope.own(() => device?.removeEventListener('uncapturederror', lost))
  canvas.addEventListener('webglcontextlost', lost)
  scope.own(() => canvas.removeEventListener('webglcontextlost', lost))
  const resources = new SceneResources()
  scope.own(() => resources.dispose())
  observeProbes(scope, gate, resources, config)
  scope.own(onMaterialsChanged((kind) => gate.changed(performance.now(), kind === 'textures')))
  const scene = new THREE.Scene()
  const camera = new THREE.PerspectiveCamera(
    pose.fov,
    job.profile.width / job.profile.height,
    pose.near,
    pose.far,
  )
  camera.position.set(...pose.position)
  camera.up.set(...pose.up)
  camera.lookAt(...pose.target)
  camera.updateMatrixWorld()
  camera.updateProjectionMatrix()
  setMaxAnisotropy(renderer.getMaxAnisotropy())
  const root = createRoot(canvas)
  scope.own(
    () =>
      new Promise<void>((resolve, reject) => {
        // Fiber's passed-in renderer is separately owned above. Bound unmount even on React failure.
        const timeout = setTimeout(
          () => reject(new CaptureContractError('scene-failed', 'Private root unmount failed.')),
          1000,
        )
        unmountComponentAtNode(canvas, () => {
          clearTimeout(timeout)
          resolve()
        })
      }),
  )
  await scope.wait(
    root.configure({
      gl: renderer as unknown as WebGLRenderer,
      scene,
      camera,
      frameloop: 'never',
      dpr: 1,
      shadows: 'percentage',
      size: { width: job.profile.width, height: job.profile.height, top: 0, left: 0 },
    }),
  )
  scope.check()
  renderer.toneMapping = THREE.AgXToneMapping
  renderer.outputColorSpace = THREE.SRGBColorSpace
  renderer.setPixelRatio(1)
  renderer.setSize(job.profile.width, job.profile.height, false)
  console.info('[fury-capture-stage:root-configured]')
  progress('assembling', 0)
  let mounted = false
  const store = root.render(
    <SceneBoundary
      failed={() => {
        sceneFailure ??= 'Private React assembly failed.'
      }}
    >
      <CaptureAssembly config={config} view={view} />
      <CommitSignal
        ready={() => {
          mounted = true
        }}
      />
    </SceneBoundary>,
  )
  const check = () => {
    network.check()
    if (sceneFailure || (renderer as unknown as { _isDeviceLost?: boolean })._isDeviceLost)
      throw new CaptureContractError(
        'scene-failed',
        sceneFailure ?? 'Private graphics device was lost.',
      )
    if (runtime.backend === 'webgl2') {
      const gl = renderer.getContext() as WebGL2RenderingContext
      if (gl.isContextLost() || gl.getError() !== gl.NO_ERROR)
        throw new CaptureContractError('scene-failed', 'Private graphics API reported an error.')
    }
  }
  // React concurrent rendering may span several tasks. The signal runs after the authored
  // passive effects (sky generator, probes, mirror and field worker), never after an arbitrary tick.
  while (!mounted) {
    await scope.pause(10)
    check()
  }
  check()
  console.info('[fury-capture-stage:scene-mounted]')
  resources.scene(scene)
  const materials = sceneMaterials(scene)
  if (materials.length < 10 || !scene.children.some((object) => object.userData.unit === true))
    throw new CaptureContractError('scene-failed', 'Architecture did not mount.')
  console.info('[fury-capture-stage:architecture-checked]')
  const loaded = await scope.wait(
    Promise.all(
      materials.map((material) => whenMaterialLoaded(material as THREE.MeshStandardNodeMaterial)),
    ),
  )
  check()
  if (loaded.some((value) => !value))
    throw new CaptureContractError('asset-failed', 'A required material failed.')
  console.info('[fury-capture-stage:materials-loaded]')
  // Custom ground nodes are not in materialLoaded's private WeakMap. Check every actually
  // requested set via loadedMaps as well; network failure is sticky, never a neutral fallback.
  while (!network.materialsReady() || !gate.siteField) {
    await scope.pause(50)
    check()
  }
  gate.materials = true
  console.info('[fury-capture-stage:site-field-ready]')
  gate.changed(performance.now())
  await scope.pause(350) // authored 250/300ms texture/probe debounce, with no wasted render frames
  check()
  const exposure = exposureAt(config.time)[view]
  if (Math.abs(renderer.toneMappingExposure - exposure) > 1e-8)
    throw new CaptureContractError('scene-failed', 'Authored exposure was not applied.')
  const pipeline = createPipeline(renderer, scene, camera, 'lite')
  scope.own(() => pipeline.dispose())
  progress('warming', 0)
  console.info('[fury-capture-stage:warm-start]')
  await scope.wait(pipeline.warm())
  check()
  console.info('[fury-capture-stage:warm-complete]')
  let observedMainPass = false
  const originalRender = renderer.render
  renderer.render = function (drawScene, drawCamera) {
    const target = renderer.getRenderTarget()
    const mainPass = drawScene === scene && drawCamera === camera
    if (
      mainPass &&
      (!target ||
        target.samples !== 4 ||
        target.width !== job.profile.width ||
        target.height !== job.profile.height ||
        target.texture.type !== THREE.HalfFloatType)
    )
      throw new CaptureContractError(
        'unsupported-renderer',
        'Actual Lite render target differs from the fixed HDR/MSAA profile.',
      )
    originalRender.call(renderer, drawScene, drawCamera)
    if (mainPass) observedMainPass = true
  }
  scope.own(() => {
    renderer.render = originalRender
  })
  const checkFinalReadiness = () => {
    check()
    assertMountedCamera(camera, pose, job.profile.width / job.profile.height)
    if (
      !observedMainPass ||
      renderer.toneMapping !== THREE.AgXToneMapping ||
      renderer.outputColorSpace !== THREE.SRGBColorSpace ||
      renderer.getPixelRatio() !== 1 ||
      Math.abs(renderer.toneMappingExposure - exposure) > 1e-8
    )
      throw new CaptureContractError('identity-mismatch', 'Actual render/color profile changed.')
    if (
      !gate.settled(performance.now()) ||
      sceneMaterials(scene).some(
        (material) => !materialLoaded(material as THREE.MeshStandardNodeMaterial),
      ) ||
      !network.materialsReady() ||
      canvas.width !== job.profile.width ||
      canvas.height !== job.profile.height
    )
      throw new CaptureContractError('asset-failed', 'Final scene readiness changed.')
  }
  for (let frames = 1; frames <= job.profile.maxFrames; frames++) {
    check()
    beginFrame(renderer)
    store.getState().advance(performance.now() / 1000, false)
    pipeline.render()
    resources.scene(scene)
    const ready = gate.frame(performance.now())
    progress('settling', frames)
    if (frames >= job.profile.minFrames && ready) {
      checkFinalReadiness()
      network.maps().forEach((texture) => resources.add(texture))
      progress('encoding', frames)
      // toBlob is invoked before yielding after the intended final draw. No screenshot of DOM,
      // no stale drawing-buffer read on the next animation tick, and no historical still.
      const pending = new Promise<Blob>((resolve, reject) =>
        canvas.toBlob((blob) => {
          if (blob) resolve(blob)
          else reject(new CaptureContractError('invalid-artifact', 'Canvas PNG encoding failed.'))
        }, 'image/png'),
      )
      const blob = await scope.wait(pending)
      check()
      const queue = (
        renderer.backend as unknown as {
          device?: { queue?: { onSubmittedWorkDone(): Promise<void> } }
        }
      ).device?.queue
      if (queue) await scope.wait(queue.onSubmittedWorkDone())
      check()
      const pngBase64 = await encodedPixels(blob, job, scope)
      checkFinalReadiness()
      return { pngBase64, camera: pose, runtime, renderedFrames: frames }
    }
    await scope.pause(50)
    check()
  }
  throw new CaptureContractError('limit-exceeded', 'Scene did not settle in 64 bounded frames.')
}

import {
  HalfFloatType,
  NearestFilter,
  RGBAFormat,
  RedIntegerFormat,
  StorageTexture,
  UnsignedIntType,
  type Texture,
  type WebGPURenderer,
} from 'three/webgpu'
import { globalId, texture, textureStore, uniform } from 'three/tsl'
import { wgslTagFn } from 'three-mesh-bvh/src/webgpu/nodes/WGSLTagFnNode.js'
import { ComputeKernel } from 'three-gpu-pathtracer/src/webgpu/compute/ComputeKernel.js'

/**
 * Adaptive sampling judged on the image people see.
 *
 * A fixed sample count spends as much on open sky as on the inside of a glass door. What matters
 * is the denoised picture: once more samples no longer change it, the region is finished,
 * however much raw noise the denoiser is still removing. Each time a new denoised image arrives
 * (milestones double the sample count), it is compared with the previous one in 16-pixel tiles.
 * A tile whose image changed by less than 1% on average, and nowhere by more than 15%, at two
 * doublings in a row has settled; pixels whose tile and all neighbouring tiles have settled are
 * marked complete, and the tracer spends its time on the regions still changing. The view is
 * finished when every region has settled, or at the sample cap.
 */

/** Mean relative change in luminance below which a tile has settled. */
export const SETTLED_CHANGE = 0.01
/** Largest single-pixel relative change a settled tile may show (edges jitter in the denoiser). */
export const SETTLED_PEAK = 0.15
/** Both images compared must have at least this many samples in every pixel. */
export const MIN_SETTLE_SAMPLES = 16
/** Tile size in pixels. */
export const TILE = 16

/** Layout of the tracer's sample count texels (three-gpu-pathtracer/src/webgpu/constants.js). */
const SAMPLE_COUNT_MASK = 0x3fffffff

function storageTexture(format: number, type: number) {
  const t = new StorageTexture(1, 1)
  t.format = format as typeof t.format
  t.type = type as typeof t.type
  t.generateMipmaps = false
  t.minFilter = t.magFilter = NearestFilter
  return t
}

/** One thread per tile: has the denoised image in this tile stopped changing? */
class SettleKernel extends ComputeKernel {
  declare current: Texture
  declare previous: Texture
  declare tiles: Texture
  declare streak: Texture
  declare change: number
  declare peak: number
  declare tile: number

  constructor() {
    const params = {
      globalId,
      current: texture(storageTexture(RGBAFormat, HalfFloatType)),
      previous: texture(storageTexture(RGBAFormat, HalfFloatType)),
      tiles: textureStore(storageTexture(RedIntegerFormat, UnsignedIntType)).toWriteOnly(),
      // consecutive settled comparisons per tile
      streak: textureStore(storageTexture(RedIntegerFormat, UnsignedIntType)).toReadWrite(),
      change: uniform(SETTLED_CHANGE),
      peak: uniform(SETTLED_PEAK),
      tile: uniform(TILE, 'uint'),
    }
    const fn = wgslTagFn /* wgsl */ `
      fn compute( globalId: vec3u, change: f32, peak: f32, tile: u32 ) -> void {

        let tiles = textureDimensions( ${params.tiles} );
        if ( globalId.x >= tiles.x || globalId.y >= tiles.y ) {
          return;
        }
        let size = textureDimensions( ${params.current}, 0 );
        let weights = vec3f( 0.2126, 0.7152, 0.0722 );
        var total = 0.0;
        var worst = 0.0;
        var pixels = 0.0;
        for ( var y = 0u; y < tile; y ++ ) {
          for ( var x = 0u; x < tile; x ++ ) {
            let p = globalId.xy * tile + vec2u( x, y );
            if ( p.x >= size.x || p.y >= size.y ) {
              continue;
            }
            let a = dot( textureLoad( ${params.current}, p, 0 ).rgb, weights );
            let b = dot( textureLoad( ${params.previous}, p, 0 ).rgb, weights );
            // relative, with a floor so near-black pixels do not count as large changes
            let d = abs( a - b ) / ( max( a, b ) + 0.02 );
            total += d;
            worst = max( worst, d );
            pixels += 1.0;
          }
        }
        let settled = pixels > 0.0 && total / pixels < change && worst < peak;
        // one quiet comparison can be chance: a tile must settle twice in a row
        let streak = select( 0u, textureLoad( ${params.streak}, globalId.xy ).r + 1u, settled );
        textureStore( ${params.streak}, globalId.xy, vec4u( streak ) );
        textureStore( ${params.tiles}, globalId.xy, vec4u( select( 0u, 1u, streak >= 2u ) ) );

      }
    `
    super(fn(params))
    this.defineUniformAccessors(params)
  }
}

/** Marks pixels complete whose tile and neighbouring tiles have all settled. */
class RetireKernel extends ComputeKernel {
  declare counts: Texture
  declare tiles: Texture
  declare sampleTarget: number
  declare tile: number

  constructor() {
    const params = {
      globalId,
      counts: textureStore(storageTexture(RedIntegerFormat, UnsignedIntType)).toReadWrite(),
      tiles: texture(storageTexture(RedIntegerFormat, UnsignedIntType)),
      sampleTarget: uniform(0, 'uint'),
      tile: uniform(TILE, 'uint'),
    }
    // Sample counts are indexed by tracer pixel (rows bottom up), images by row (top down).
    const fn = wgslTagFn /* wgsl */ `
      fn compute( globalId: vec3u, sampleTarget: u32, tile: u32 ) -> void {

        let size = textureDimensions( ${params.counts} );
        if ( globalId.x >= size.x || globalId.y >= size.y ) {
          return;
        }
        let raw = textureLoad( ${params.counts}, globalId.xy ).r;
        if ( ( raw & ${SAMPLE_COUNT_MASK}u ) >= sampleTarget ) {
          return;
        }
        let home = vec2i( vec2u( globalId.x, size.y - 1u - globalId.y ) / tile );
        let tiles = vec2i( textureDimensions( ${params.tiles}, 0 ) );
        // a region still changing keeps its neighbours going, so finished areas end smoothly
        for ( var dy = -1; dy <= 1; dy ++ ) {
          for ( var dx = -1; dx <= 1; dx ++ ) {
            let t = clamp( home + vec2i( dx, dy ), vec2i( 0 ), tiles - 1 );
            if ( textureLoad( ${params.tiles}, t, 0 ).r == 0u ) {
              return;
            }
          }
        }
        // keep the tracer's flag bits; the count now says "done"
        textureStore( ${params.counts}, globalId.xy, vec4u( ( raw & ~${SAMPLE_COUNT_MASK}u ) | sampleTarget ) );

      }
    `
    super(fn(params))
    this.defineUniformAccessors(params)
  }
}

/** Retires settled regions of one path tracer's view. */
export class AdaptiveSampler {
  private readonly tiles = storageTexture(RedIntegerFormat, UnsignedIntType)
  private readonly streak = storageTexture(RedIntegerFormat, UnsignedIntType)
  /** Tile size in pixels. */
  tile = TILE
  private fresh = true
  private settle: SettleKernel | null = null
  private retire: RetireKernel | null = null
  /** Mean relative change below which a tile has settled; zero or less disables retiring. */
  change = SETTLED_CHANGE

  /**
   * Compares two denoised images of the same view, `previous` from fewer samples, and marks the
   * pixels of settled regions complete in the tracer's sample counts.
   */
  update(
    renderer: WebGPURenderer,
    current: Texture,
    previous: Texture,
    counts: StorageTexture,
    target: number,
  ) {
    if (this.change <= 0) return
    const { width, height } = counts.image as { width: number; height: number }
    const columns = Math.ceil(width / this.tile)
    const rows = Math.ceil(height / this.tile)
    const size = this.tiles.image as { width: number; height: number }
    if (size.width !== columns || size.height !== rows || this.fresh) {
      // a new view (or size): no tile has settled yet
      this.tiles.setSize(columns, rows, 1)
      this.streak.dispose()
      this.streak.setSize(columns, rows, 1)
      this.fresh = false
    }
    const s = (this.settle ??= new SettleKernel().setWorkgroupSize(8, 8, 1) as SettleKernel)
    s.current = current
    s.previous = previous
    s.tiles = this.tiles
    s.streak = this.streak
    s.change = this.change
    s.tile = this.tile
    renderer.compute(s.kernel, s.getDispatchSize(columns, rows, 1))
    const r = (this.retire ??= new RetireKernel().setWorkgroupSize(8, 8, 1) as RetireKernel)
    r.counts = counts
    r.tiles = this.tiles
    r.sampleTarget = target
    r.tile = this.tile
    renderer.compute(r.kernel, r.getDispatchSize(width, height, 1))
  }

  /** Starts a new view: no region has settled. */
  reset() {
    this.fresh = true
  }

  dispose() {
    this.tiles.dispose()
    this.streak.dispose()
    this.settle?.dispose()
    this.retire?.dispose()
  }
}

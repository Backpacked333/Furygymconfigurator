import {
  Data3DTexture,
  DataUtils,
  HalfFloatType,
  LinearFilter,
  RGBAFormat,
  Vector3,
  Vector4,
  type Node,
} from 'three/webgpu'
import {
  Fn,
  clamp,
  dot,
  float,
  max,
  mix,
  normalWorld,
  positionWorld,
  step,
  texture3D,
  uniform,
  vec3,
} from 'three/tsl'
import type { Config } from '../lib/config'
import { FLOOR_Y, interiorBounds } from './envelope'
import { FIELD_DIMS, siteField, type SiteLightField } from './siteLight'

/**
 * The live view's side of the site light field (siteLight.ts): the field as a 3D texture, and the
 * scale it puts on each outdoor surface's ambient light, the ratio of the light reaching it to the
 * light reaching the capture point for the way it faces. The pipeline multiplies it into the
 * ambient occlusion (pipeline.ts), so it scales the image-based light alone: the sun and the
 * lamps are untouched. Inside the room, lit by its own probe, and outside the field it is 1.
 */

const [nx, ny, nz] = FIELD_DIMS
const texture = new Data3DTexture(new Uint16Array(nx * ny * nz * 4), nx, ny, nz)
texture.format = RGBAFormat
texture.type = HalfFloatType
texture.minFilter = texture.magFilter = LinearFilter
texture.unpackAlignment = 1
texture.needsUpdate = true

const origin = uniform(new Vector3())
const span = uniform(new Vector3(1, 1, 1))
const capture = uniform(new Vector4(1, 0, 0, 0))
const enabled = uniform(0)
/** The room's inside (feet): its light is its own probe's. */
const roomLow = uniform(new Vector3())
const roomHigh = uniform(new Vector3())

/** How far along its normal a surface reads the field: half a cell, off its own face. */
const OFFSET = 1.5
/** The scale is kept to this range, as on the CPU (siteLight.ts siteLightScale). */
const LEAST = 0.15
const MOST = 2

/** Puts a design's field in place, or none (the studio); `room` is the unit's inside. */
export function setSiteField(
  field: SiteLightField | null,
  room: { low: [number, number, number]; high: [number, number, number] },
) {
  roomLow.value.set(...room.low)
  roomHigh.value.set(...room.high)
  if (!field) {
    enabled.value = 0
    return
  }
  const data = texture.image.data as Uint16Array
  for (let i = 0; i < field.values.length; i++) data[i] = DataUtils.toHalfFloat(field.values[i])
  texture.needsUpdate = true
  origin.value.set(...field.origin)
  span.value.set(
    ...([0, 1, 2].map((i) => field.cell[i] * (field.dims[i] - 1)) as [number, number, number]),
  )
  capture.value.set(...field.capture)
  enabled.value = 1
}

const inside = (p: Node<'vec3'>, low: Node<'vec3'>, high: Node<'vec3'>) =>
  step(low.x, p.x)
    .mul(step(p.x, high.x))
    .mul(step(low.y, p.y))
    .mul(step(p.y, high.y))
    .mul(step(low.z, p.z))
    .mul(step(p.z, high.z))

/** The scale on a surface's ambient light (1 where the field does not apply). */
export const siteAmbient = Fn(() => {
  const n = normalWorld
  const p = positionWorld.add(n.mul(OFFSET))
  const at = p.sub(origin).div(span)
  // Texel centres: the field's first and last cells sit on the texture's edges.
  const dims = vec3(nx, ny, nz)
  const uvw = at.mul(dims.sub(1)).add(0.5).div(dims)
  const w = texture3D(texture, uvw)
  const here = max(w.x.add(dot(w.yzw, n)), 0)
  const there = max(capture.x.add(dot(capture.yzw, n)), 1e-6)
  const scale = clamp(here.div(there), LEAST, MOST)
  const applies = enabled
    .mul(inside(at, vec3(0), vec3(1)))
    .mul(float(1).sub(inside(positionWorld, roomLow, roomHigh)))
  return mix(float(1), scale, applies)
})

type Design = Parameters<typeof siteField>[0]
let worker: Worker | null | undefined
let ticket = 0
/**
 * A design's field, worked out in a worker (about a second for the larger courts): the latest
 * request is answered, earlier ones that have not been never are. Without workers (tests), at once.
 */
export function requestSiteField(design: Design): Promise<SiteLightField | null> {
  if (design.environment === 'studio') return Promise.resolve(null)
  if (worker === undefined)
    try {
      worker =
        typeof Worker === 'undefined'
          ? null
          : new Worker(new URL('./siteLight.worker.ts', import.meta.url), { type: 'module' })
    } catch {
      worker = null
    }
  const pick = ({ environment, length, family, time }: Design) => ({
    environment,
    length,
    family,
    time,
  })
  if (!worker) return Promise.resolve(siteField(pick(design)))
  const id = ++ticket
  const w = worker
  return new Promise((resolve) => {
    const answer = (event: MessageEvent) => {
      if (event.data.id !== id) return
      w.removeEventListener('message', answer)
      resolve(event.data.field as SiteLightField | null)
    }
    w.addEventListener('message', answer)
    w.postMessage({ id, design: pick(design) })
  })
}

/** The unit's inside, where the field gives way to the room's probe (feet). */
export function roomInside(c: Config) {
  const b = interiorBounds(c)
  return {
    low: [-b.halfWidth - 0.1, FLOOR_Y - 0.3, b.back - 0.1] as [number, number, number],
    high: [b.halfWidth + 0.1, b.ceiling + 0.1, b.front + 0.1] as [number, number, number],
  }
}

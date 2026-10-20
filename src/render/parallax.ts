import { Vector3, type Node } from 'three/webgpu'
import {
  Fn,
  dot,
  float,
  max,
  min,
  normalWorld,
  positionWorld,
  select,
  sqrt,
  uniform,
} from 'three/tsl'
import type { pmremTexture } from 'three/tsl'

type Probe = ReturnType<typeof pmremTexture>
type Builder = { context: { getUV?: (node: Probe, builder: unknown) => Node<'vec3'> } }

/**
 * A radiance probe looked up from where each surface is rather than from where it was captured.
 * A cube capture records the site as seen from its centre; a surface ten feet from that centre
 * looking the same way sees other things: the back of the unit, captured from in front of it,
 * reflected the unit's own shadow on the paving where, traced, it reflects the sunlit paving past
 * the shadow, and read more than a stop too dark. Each look-up's direction is turned to where its
 * ray from the surface meets a stand-in for the site, the ground and a sphere of the court's size
 * round the capture point, as seen from the capture point (a parallax-corrected cube map).
 */
export function parallaxProbe(probe: Probe, center: Vector3, radius: number) {
  const origin = uniform(center)
  const reach = float(radius)
  return {
    origin,
    // A function of the builder alone: called once per look-up, in that look-up's context.
    node: (Fn as unknown as (f: (builder: Builder) => Node) => () => Node)((builder) => {
      const { getUV } = builder.context
      const direction = (getUV ? getUV(probe, builder) : normalWorld).normalize()
      const from = positionWorld.sub(origin)
      // Where the ray leaves the sphere (the surface is inside it)...
      const b = dot(from, direction)
      // A surface beyond the sphere (a far facade's window) is taken at its own distance.
      const r = max(reach, from.length().add(1))
      const c = dot(from, from).sub(r.mul(r))
      const sphere = b.negate().add(sqrt(max(b.mul(b).sub(c), 0)))
      // ...or meets the ground first, going down.
      const ground = select(
        direction.y.lessThan(-1e-3),
        max(positionWorld.y, 0).div(direction.y.negate()),
        float(1e6),
      )
      const hit = from.add(direction.mul(min(sphere, ground)))
      return probe.context({ getUV: () => hit.normalize() })
    })(),
  }
}

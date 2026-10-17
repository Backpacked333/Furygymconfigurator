import type { Node } from 'three/webgpu'
import { acos, dot, float, normalize, smoothstep, uniform } from 'three/tsl'
import { CIRCUMSOLAR } from '../lib/visuals'

/**
 * 1 while a radiance capture is being taken, 0 otherwise. The sky drawn into a capture leaves out
 * the circumsolar glow (visuals.ts CIRCUMSOLAR), which the sun light carries with its shadow;
 * the sky seen in the view keeps it.
 */
export const circumsolarCut = uniform(0)

/**
 * What a sky keeps of its radiance in `direction` (unit vector) with the sun toward `sun`: all of
 * it, unless `cut` (1 in a capture) takes out the circumsolar share, as `circumsolarShare` weighs it.
 */
export function circumsolarKeep(direction: Node<'vec3'>, sun: Node<'vec3'>, cut: Node<'float'>) {
  const angle = acos(dot(direction, normalize(sun)).clamp(-1, 1))
  const share = float(1).sub(smoothstep(CIRCUMSOLAR.inner, CIRCUMSOLAR.outer, angle))
  return float(1).sub(cut.mul(share))
}

/** Runs a radiance capture with the circumsolar glow left out of the sky. */
export function withoutCircumsolar<T>(capture: () => T): T {
  circumsolarCut.value = 1
  try {
    return capture()
  } finally {
    circumsolarCut.value = 0
  }
}

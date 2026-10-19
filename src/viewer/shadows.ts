import type { Light, LightShadow, Object3D } from 'three'

/**
 * Shadow maps depend only on the scene and its lights, never on the camera, so they are rendered
 * when something changes rather than on every frame. A 4096-pixel sun map redrawn for each orbit
 * and settle frame (and again for the mirror's reflected camera) is the largest fixed cost of a
 * frame. Anything that moves, adds, or hides a shadow caster or a shadow-casting light must call
 * `invalidateShadows`: configuration and quality changes (SceneRefresh), streamed textures and
 * interior probe captures (which draw shadows with foliage and glazing hidden).
 */
const dirty = new WeakSet<Object3D>()

export function invalidateShadows(scene: Object3D) {
  dirty.add(scene)
}

/**
 * Called right before a frame renders: redraws every shadow map once if the scene changed.
 * Returns whether it did, which also marks a frame carrying one-off work after a change.
 */
export function refreshShadows(scene: Object3D) {
  if (!dirty.has(scene)) return false
  dirty.delete(scene)
  scene.traverse((object) => {
    const light = object as Light & { shadow?: LightShadow }
    if (!light.isLight || !light.castShadow || !light.shadow) return
    light.shadow.autoUpdate = false
    light.shadow.needsUpdate = true
  })
  return true
}

/** Whether shadow maps wait for a redraw: light probes capture only once they are current. */
export function shadowsPending(scene: Object3D) {
  return dirty.has(scene)
}

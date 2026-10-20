import { useCallback, useSyncExternalStore } from 'react'

/**
 * The 360° view's handshake with the stage (App.tsx), kept outside React state and free of
 * three.js imports, like stillStatus.ts:
 *
 * - `settled` counts the live view's settle runs as they finish: the stage reveals the canvas
 *   under a still only once it has drawn a settled frame, never one still converging.
 * - `freezeLiveView` draws the live view's next frame into a canvas of the stage's and says where
 *   the camera stands: leaving the 360° view holds that frame, as an image, until the still of
 *   the nearest gallery angle is in (RenderEffects serves it).
 */

type Vec3 = [number, number, number]
/** Where the live camera stands, and the way it looks. */
export type LivePose = { position: Vec3; forward: Vec3 }
type Freezer = (target: HTMLCanvasElement) => Promise<LivePose | null>

let settled = 0
const listeners = new Set<() => void>()

/** A settle run of the live view has finished: the canvas shows a settled frame. */
export function liveSettled() {
  settled++
  listeners.forEach((listener) => listener())
}

export const settledRuns = () => settled

function subscribe(listener: () => void) {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/**
 * Settle runs of the live view so far, re-rendering as they finish only while `watching`: on Lite
 * every frame of an orbit is a run of its own.
 */
export function useSettledRuns(watching: boolean) {
  const watch = useCallback(
    (listener: () => void) => (watching ? subscribe(listener) : () => {}),
    [watching],
  )
  return useSyncExternalStore(watch, settledRuns, settledRuns)
}

let freezer: Freezer | null = null

/** RenderEffects offers its frames (null once its renderer is gone). */
export function setFreezer(next: Freezer | null) {
  freezer = next
}

/**
 * The live view's next frame, drawn into `target`, and the camera's pose; null when there is no
 * live view to draw, or it took longer than `timeoutMs` (the 3D view is gone or stalled).
 */
export function freezeLiveView(target: HTMLCanvasElement, timeoutMs = 600) {
  if (!freezer) return Promise.resolve(null)
  return Promise.race([
    freezer(target),
    new Promise<null>((resolve) => setTimeout(() => resolve(null), timeoutMs)),
  ])
}

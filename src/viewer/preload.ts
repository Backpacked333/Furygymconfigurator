import { whenIdle } from './idle'

let started = false

/**
 * Starts downloading the 3D code as soon as the page has painted, instead of when the 3D view
 * first mounts: the chunk then arrives in parallel with the rest of the first load rather than
 * in a waterfall after it. `load` is the same dynamic import the lazy component uses, so the
 * module is fetched (and evaluated) once. Skipped on Save-Data connections.
 */
export function preloadViewer(load: () => Promise<unknown>) {
  if (started) return
  started = true
  const nav = navigator as Navigator & { connection?: { saveData?: boolean } }
  if (nav.connection?.saveData) return
  requestAnimationFrame(() => whenIdle(() => void load().catch(() => {}), 500))
}

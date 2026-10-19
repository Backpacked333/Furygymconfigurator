/**
 * Runs background work when the page is idle, or after `timeout` ms at the latest. Without the
 * deadline, a device whose frames use the whole frame budget (a slow GPU still converging an
 * image) would never be idle, and the work would never run.
 */
export function whenIdle(callback: () => void, timeout = 2000) {
  if (typeof window.requestIdleCallback === 'function')
    window.requestIdleCallback(callback, { timeout })
  else setTimeout(callback, Math.min(timeout, 300))
}

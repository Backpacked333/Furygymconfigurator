/**
 * What a sample of the live trace costs on this device: milliseconds per megapixel-sample, per GPU
 * and quality tier, measured by the view as it refines (ProgressiveRenderer) and kept across
 * visits, so the next view starts at the resolution that keeps it fast (liveProfile.ts
 * budgetPixels). Storage may be unavailable (private windows, blocked site data): it is then kept
 * for this page only.
 */
const PREFIX = 'fury:trace-cost:'
const memory = new Map<string, number>()

export function traceCost(key: string): number | null {
  if (memory.has(key)) return memory.get(key)!
  try {
    const stored = Number(window.localStorage.getItem(PREFIX + key))
    if (Number.isFinite(stored) && stored > 0) {
      memory.set(key, stored)
      return stored
    }
  } catch {
    // Unavailable: this page only.
  }
  return null
}

/** Records a measurement, averaged with what was known, so one slow moment does not set it. */
export function recordTraceCost(key: string, msPerMegapixelSample: number) {
  if (!Number.isFinite(msPerMegapixelSample) || msPerMegapixelSample <= 0) return
  const known = traceCost(key)
  const value = known === null ? msPerMegapixelSample : (known + msPerMegapixelSample) / 2
  memory.set(key, value)
  try {
    window.localStorage.setItem(PREFIX + key, String(value))
  } catch {
    // Unavailable: this page only.
  }
}

/** Forgets every cost kept, in memory and stored (tests, and a reset on request). */
export function forgetTraceCosts() {
  memory.clear()
  try {
    for (const key of Object.keys(window.localStorage))
      if (key.startsWith(PREFIX)) window.localStorage.removeItem(key)
  } catch {
    // Unavailable: nothing stored.
  }
}

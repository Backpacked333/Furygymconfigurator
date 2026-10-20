/** Load progress of the material library, observable without importing three.js. */
type Listener = () => void
const listeners = new Set<Listener>()
let snapshot = { requested: 0, loaded: 0 }

export const textureProgress = {
  subscribe(listener: Listener) {
    listeners.add(listener)
    return () => {
      listeners.delete(listener)
    }
  },
  get: () => snapshot,
  /** Called by the material library as maps are requested and arrive. */
  update(requested: number, loaded: number) {
    snapshot = { requested: snapshot.requested + requested, loaded: snapshot.loaded + loaded }
    listeners.forEach((listener) => listener())
  },
}

/** Where the 3D view is on its way to a first picture. */
export type ScenePhase = 'engine' | 'renderer' | 'shaders' | 'ready'
const phaseListeners = new Set<Listener>()
let phase: ScenePhase = 'engine'
let afterDraw: (() => void)[] = []

export const sceneProgress = {
  subscribe(listener: Listener) {
    phaseListeners.add(listener)
    return () => {
      phaseListeners.delete(listener)
    }
  },
  get: () => phase,
  set(next: ScenePhase) {
    if (phase === next) return
    phase = next
    phaseListeners.forEach((listener) => listener())
  },
  /** Runs `callback` once, after the next frame the scene draws. */
  afterNextDraw(callback: () => void) {
    afterDraw.push(callback)
    return () => {
      afterDraw = afterDraw.filter((c) => c !== callback)
    }
  },
  /** Called by the scene each time it draws a frame. */
  drawn() {
    sceneProgress.set('ready')
    if (!afterDraw.length) return
    const callbacks = afterDraw
    afterDraw = []
    callbacks.forEach((callback) => callback())
  },
}

/**
 * Where the live 360° view is on its way from the press of "Explore in 360°" to a view that can
 * be explored without a stall: the engine's code, the scene, its materials and light (scans and
 * shaders), the path tracer's first start (its scene capture, the view's longest task). `ready`
 * once that start has happened, or once it cannot (no WebGPU, a failure).
 */
export const LIVE_STEPS = ['engine', 'scene', 'materials', 'tracer', 'ready'] as const
export type LiveStep = (typeof LIVE_STEPS)[number]
const liveListeners = new Set<Listener>()
let liveStep: LiveStep = 'engine'

export const liveLoading = {
  subscribe(listener: Listener) {
    liveListeners.add(listener)
    return () => {
      liveListeners.delete(listener)
    }
  },
  get: () => liveStep,
  /** Moves to `next`; never back, except through `restart`. */
  set(next: LiveStep) {
    if (LIVE_STEPS.indexOf(next) <= LIVE_STEPS.indexOf(liveStep)) return
    liveStep = next
    liveListeners.forEach((listener) => listener())
  },
  /** A new live view is starting from nothing. */
  restart() {
    if (liveStep === 'engine') return
    liveStep = 'engine'
    liveListeners.forEach((listener) => listener())
  },
}

/**
 * Render-cost estimates for scheduling. The visible status uses observed request stages and
 * measured local samples instead: elapsed time is not evidence of cloud render completion.
 */

/** Seed for the cloud's cost before any frame has come back: 1.5 s for 64 samples at 1200x827. */
export const SEED_MS_PER_PIXEL_SAMPLE = 1500 / (1200 * 827 * 64)
/** What a frame costs besides its samples: the request, preparing the scene, finishing, the trip. */
export const FRAME_OVERHEAD_MS = 600
/**
 * Allowed on top for the page's first frame: the scene's data uploads, and a GPU that may be
 * starting.
 */
export const FIRST_FRAME_MS = 8000
/** Where an estimate stops until the still is there. */
export const PROGRESS_CAP = 0.92
/** Frames the median cost is taken over. */
const RATE_WINDOW = 16

let rates: number[] = []

function median(values: number[]) {
  const sorted = [...values].sort((a, b) => a - b)
  const mid = sorted.length >> 1
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2
}

export type FrameCost = { width: number; height: number; samples: number; timeLimit: number }

export const renderRate = {
  /**
   * A frame the server rendered (not one from its cache). One stopped by its time limit rendered
   * fewer samples than asked, so a sample cost at least this much: kept as it is, it has the next
   * estimates reach for the time limit too, as they should on so slow a GPU.
   */
  record(renderMs: number, frame: FrameCost) {
    const work = frame.width * frame.height * frame.samples
    if (!(renderMs > 0) || !(work > 0)) return
    rates.push(renderMs / work)
    if (rates.length > RATE_WINDOW) rates = rates.slice(-RATE_WINDOW)
  },
  /** Whether a frame has been rendered for this page: before one, the GPU may still be starting. */
  learned() {
    return rates.length > 0
  },
  /** The median cost of a pixel sample this page has seen, or the seed before any. */
  msPerPixelSample() {
    return rates.length ? median(rates) : SEED_MS_PER_PIXEL_SAMPLE
  },
  /** How long a frame should take once the GPU starts on it, capped by its time limit. */
  estimateMs(frame: FrameCost) {
    const samples = frame.width * frame.height * frame.samples * renderRate.msPerPixelSample()
    return Math.min(frame.timeLimit * 1000, samples) + FRAME_OVERHEAD_MS
  },
  /** Back to nothing seen (tests). */
  reset() {
    rates = []
  },
}

/**
 * The wait for a frame: its own time, plus what is left of each frame ahead of it on the GPU
 * (estimated, and how long it has been under way).
 */
export function queueEstimate(ownMs: number, ahead: { estimateMs: number; elapsedMs: number }[]) {
  return ownMs + ahead.reduce((sum, a) => sum + Math.max(0, a.estimateMs - a.elapsedMs), 0)
}

/**
 * Estimated progress after `elapsedMs` of an `expectedMs` wait: quick at first, about 85% at the
 * expected time, never past PROGRESS_CAP however late the frame is.
 */
export function estimatedProgress(elapsedMs: number, expectedMs: number) {
  if (!(expectedMs > 0)) return 0
  const x = Math.max(0, elapsedMs) / expectedMs
  return PROGRESS_CAP * (1 - Math.exp(-2.5 * x))
}

/**
 * Estimated progress carried on from `from` after an estimate was revised: `sinceMs` after the
 * revision, with `remainingMs` then left. It starts where the line was and eases toward the cap
 * at the same pace as a fresh estimate, so a revision never moves the line back. From 0 it is
 * `estimatedProgress`.
 */
export function continuedProgress(from: number, sinceMs: number, remainingMs: number) {
  const start = Math.min(PROGRESS_CAP, Math.max(0, from))
  if (!(remainingMs > 0)) return start
  const eased = 1 - Math.exp((-2.5 * Math.max(0, sinceMs)) / remainingMs)
  return start + (PROGRESS_CAP - start) * eased
}

/** A local trace's progress: the samples every pixel has, of the target. */
export const measuredProgress = (samples: number, target: number) =>
  target > 0 ? Math.min(1, Math.max(0, samples / target)) : 0

/** Seconds to say in "about N s": at least one, and null once the estimate has run out. */
export function secondsLeft(elapsedMs: number, expectedMs: number) {
  const left = expectedMs - elapsedMs
  return left > 0 ? Math.max(1, Math.ceil(left / 1000)) : null
}

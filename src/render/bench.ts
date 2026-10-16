import { useSyncExternalStore } from 'react'

/**
 * What `?bench=1` reports (App.tsx BenchPanel, docs/benchmarks.md): when the live view, the first
 * path-traced preview and the first good frame reached the screen, how the cloud answered, what
 * each of its frames cost, and how long the local tracer took. Marks are milliseconds since the
 * page started (performance.now()). Kept outside React and free of three.js imports, like
 * traceStatus.ts, so the app shell can show it; recording is a few assignments, so it runs
 * whether or not the panel is open.
 */

/**
 * Firsts on the way to a path-traced view, each recorded once: when the live view drew, when the
 * scanned textures had settled, when the scene was captured for the cloud, when the first request
 * went to it, and when its first preview and first good frame were on screen.
 */
export type Mark =
  | 'firstRaster'
  | 'texturesSettled'
  | 'sceneCaptured'
  | 'firstRequest'
  | 'firstPreview'
  | 'firstGood'
  | 'firstLocalTrace'
/**
 * How the cloud is answering: `off` until it has (or none is configured), `cold` when its first
 * answer came from the shared renderer or took a container start, `warm` when it answered at once,
 * `full` while every GPU is in use, `failed` once the spin gave up on it.
 */
export type CloudState = 'off' | 'cold' | 'warm' | 'full' | 'failed'

export type BenchStats = {
  marks: Record<Mark, number | null>
  cloud: CloudState
  /** Cloud frames answered, and of those from the server's cache. */
  frames: number
  cached: number
  /** How many each renderer answered (X-Fury-Renderer): the session's own GPU or the shared one. */
  renderer: { own: number; shared: number }
  /**
   * Medians over the last frames the server rendered (cache hits left out): its render and
   * finishing time, and the whole round trip as the browser saw it.
   */
  renderMs: number | null
  finishMs: number | null
  totalMs: number | null
  /** The local tracer's last view: milliseconds to its first denoised image, and to settling. */
  local: { firstMs: number | null; settledMs: number | null }
}

/** A first answer later than this came from a container that started for this page. */
export const COLD_MS = 8000
/** Frames the medians are taken over. */
const WINDOW = 24

type Answered = { renderMs: number; finishMs: number | null; totalMs: number }

const fresh = (): BenchStats => ({
  marks: {
    firstRaster: null,
    texturesSettled: null,
    sceneCaptured: null,
    firstRequest: null,
    firstPreview: null,
    firstGood: null,
    firstLocalTrace: null,
  },
  cloud: 'off',
  frames: 0,
  cached: 0,
  renderer: { own: 0, shared: 0 },
  renderMs: null,
  finishMs: null,
  totalMs: null,
  local: { firstMs: null, settledMs: null },
})

let stats = fresh()
let recent: Answered[] = []
const listeners = new Set<() => void>()

function median(values: number[]) {
  if (!values.length) return null
  const sorted = [...values].sort((a, b) => a - b)
  const mid = sorted.length >> 1
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2
}

function publish(next: Partial<BenchStats>) {
  stats = { ...stats, ...next }
  listeners.forEach((listener) => listener())
}

/** `?bench=1` shows the panel. */
export function benchEnabled(search = window.location.search) {
  return new URLSearchParams(search).get('bench') === '1'
}

export const bench = {
  subscribe(listener: () => void) {
    listeners.add(listener)
    return () => {
      listeners.delete(listener)
    }
  },
  get: () => stats,
  /** Records a first, the first time it is told. */
  mark(name: Mark, at = performance.now()) {
    if (stats.marks[name] !== null) return
    publish({ marks: { ...stats.marks, [name]: at } })
  },
  /**
   * A cloud answer: the first one tells cold from warm, and one after every GPU was in use says
   * a GPU is free again. A cloud that failed stays failed.
   */
  answered(answer: { renderer: string; totalMs: number }) {
    if (stats.cloud === 'off')
      publish({ cloud: answer.renderer === 'shared' || answer.totalMs > COLD_MS ? 'cold' : 'warm' })
    else if (stats.cloud === 'full') publish({ cloud: 'warm' })
  },
  /** The cloud is full of other visitors, or the spin gave up on it. */
  cloud(state: 'full' | 'failed') {
    if (stats.cloud === 'failed' || stats.cloud === state) return
    publish({ cloud: state })
  },
  /** A cloud frame that landed, with the server's timings (cloud.ts). */
  frame(frame: Answered & { cached: boolean; renderer: string }) {
    const renderer = { ...stats.renderer }
    if (frame.renderer === 'own' || frame.renderer === 'shared') renderer[frame.renderer]++
    if (!frame.cached) {
      recent.push(frame)
      if (recent.length > WINDOW) recent = recent.slice(-WINDOW)
    }
    publish({
      frames: stats.frames + 1,
      cached: stats.cached + (frame.cached ? 1 : 0),
      renderer,
      renderMs: median(recent.map((f) => f.renderMs)),
      finishMs: median(recent.flatMap((f) => (f.finishMs === null ? [] : [f.finishMs]))),
      totalMs: median(recent.map((f) => f.totalMs)),
    })
  },
  /** The local tracer's view: how long its first image took, and its settling once it has. */
  local(local: BenchStats['local']) {
    publish({ local })
  },
  /** Back to nothing recorded (tests). */
  reset() {
    stats = fresh()
    recent = []
    listeners.forEach((listener) => listener())
  },
}

export function useBench() {
  return useSyncExternalStore(bench.subscribe, bench.get, bench.get)
}

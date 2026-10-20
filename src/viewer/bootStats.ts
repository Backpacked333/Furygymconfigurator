/**
 * `?bootStats=1`: the 360° view's boot and settling, timed on the visitor's own device and shown
 * in a panel they can copy from. Times count from the press of 360° (the `fury:live-click` mark).
 *
 * It records:
 * - the view's own steps (`step`);
 * - every `fury:*` mark and measure the view leaves in the performance timeline;
 * - each restart of the trace and why (`restart`);
 * - main-thread long tasks;
 * - frames that took 100 ms or more, where a GPU stall shows (it never shows as a long task).
 *
 * Inert without the flag: no observers, no frame watcher, no DOM.
 */

/** A frame this long or longer is a stall worth listing. */
export const GAP_MS = 100

type Row = { at: number; text: string }
type Tally = { count: number; total: number; max: number }

const tally = (): Tally => ({ count: 0, total: 0, max: 0 })
const add = (t: Tally, ms: number) => {
  t.count++
  t.total += ms
  t.max = Math.max(t.max, ms)
}
const seconds = (ms: number) => `${ms >= 0 ? '+' : ''}${(ms / 1000).toFixed(2)} s`
const millis = (ms: number) => `${Math.round(ms)} ms`

export function createBootStats(enabled: boolean, doc: Document | null = null) {
  let origin: number | null = null
  let rows: Row[] = []
  let context: [string, string][] = []
  const restarts = new Map<string, number>()
  let longTasks = tally()
  let gaps = tally()
  let observers: PerformanceObserver[] = []
  let frame = 0
  let panel: HTMLElement | null = null
  let body: HTMLElement | null = null
  let pending = 0

  const now = () => performance.now()
  const since = (at: number) => at - (origin ?? at)

  const text = () => {
    const lines = ['Fury 360° boot timeline (from the press of 360°)', '']
    for (const [key, value] of context) lines.push(`${key}: ${value}`)
    if (context.length) lines.push('')
    for (const row of [...rows].sort((a, b) => a.at - b.at))
      lines.push(`${seconds(since(row.at)).padStart(9)}  ${row.text}`)
    lines.push('')
    const reasons = [...restarts].map(([reason, n]) => `${reason} ×${n}`).join(', ')
    lines.push(`Trace restarts: ${reasons || 'none'}`)
    lines.push(
      `Long tasks (main thread ≥50 ms): ${longTasks.count}, ${millis(longTasks.total)} in all, longest ${millis(longTasks.max)}`,
    )
    lines.push(
      `Stalled frames (≥${GAP_MS} ms): ${gaps.count}, ${millis(gaps.total)} in all, longest ${millis(gaps.max)}`,
    )
    return lines.join('\n')
  }

  const render = () => {
    pending = 0
    if (body) body.textContent = text()
  }
  const changed = () => {
    if (!panel || pending) return
    pending = requestAnimationFrame(render)
  }

  const record = (text: string, at = now()) => {
    rows.push({ at, text })
    changed()
  }

  const mount = () => {
    if (!doc || panel) return
    panel = doc.createElement('div')
    panel.setAttribute('data-boot-stats', '')
    panel.style.cssText =
      'position:fixed;left:8px;bottom:8px;z-index:2147483647;max-width:min(560px,calc(100vw - 16px));max-height:55vh;overflow:auto;background:rgb(255 255 255 / 0.96);color:#222;border:1px solid #ccc;border-radius:8px;box-shadow:0 6px 24px rgb(0 0 0 / 0.18);font:11px/1.45 ui-monospace,Menlo,Consolas,monospace;'
    const bar = doc.createElement('div')
    bar.style.cssText =
      'position:sticky;top:0;display:flex;gap:6px;justify-content:flex-end;padding:6px;background:inherit;border-bottom:1px solid #eee;'
    const copy = doc.createElement('button')
    copy.type = 'button'
    copy.textContent = 'Copy'
    copy.onclick = () => {
      void navigator.clipboard?.writeText(text()).then(
        () => (copy.textContent = 'Copied'),
        () => (copy.textContent = 'Select the text to copy'),
      )
    }
    const close = doc.createElement('button')
    close.type = 'button'
    close.textContent = 'Hide'
    close.onclick = () => panel?.remove()
    bar.append(copy, close)
    body = doc.createElement('pre')
    body.style.cssText = 'margin:0;padding:8px 10px;white-space:pre-wrap;user-select:text;'
    panel.append(bar, body)
    doc.body.append(panel)
    render()
  }

  const watchFrames = () => {
    let last = now()
    const tick = () => {
      const t = now()
      if (t - last >= GAP_MS) {
        add(gaps, t - last)
        changed()
      }
      last = t
      frame = requestAnimationFrame(tick)
    }
    frame = requestAnimationFrame(tick)
  }

  const observe = (type: string, onEntry: (entry: PerformanceEntry) => void) => {
    try {
      const observer = new PerformanceObserver((list) => list.getEntries().forEach(onEntry))
      observer.observe({ type, buffered: true })
      observers.push(observer)
    } catch {
      // Not supported here (long tasks: Chromium only).
    }
  }

  const stats = {
    enabled,
    /** A new view opened: starts the clock at its press of 360°, and the panel. */
    start(details: Record<string, string> = {}) {
      if (!enabled) return
      stats.stop()
      const click = performance.getEntriesByName('fury:live-click', 'mark').at(-1)
      origin = click ? click.startTime : now()
      rows = []
      context = Object.entries(details)
      restarts.clear()
      longTasks = tally()
      gaps = tally()
      record('view mounted')
      const seen = new Set<PerformanceEntry>()
      const fromTimeline = (entry: PerformanceEntry) => {
        if (seen.has(entry) || !entry.name.startsWith('fury:')) return
        if (entry.name === 'fury:live-click' || entry.startTime < (origin ?? 0)) return
        seen.add(entry)
        const name = entry.name.slice('fury:'.length)
        if (entry.entryType === 'measure')
          record(`${name} (took ${millis(entry.duration)})`, entry.startTime + entry.duration)
        else record(name, entry.startTime)
      }
      observe('mark', fromTimeline)
      observe('measure', fromTimeline)
      observe('longtask', (entry) => {
        if (entry.startTime < (origin ?? 0)) return
        add(longTasks, entry.duration)
        if (entry.duration >= 200)
          record(`main thread blocked ${millis(entry.duration)}`, entry.startTime)
        else changed()
      })
      watchFrames()
      mount()
    },
    /** Adds what the view knows about itself (GPU, quality, sizes) to the panel's header. */
    context(key: string, value: string) {
      if (!enabled) return
      context = [...context.filter(([k]) => k !== key), [key, value]]
      changed()
    },
    /** A step of the view's boot, now or at `at` (a performance.now() time). */
    step(text: string, at?: number) {
      if (!enabled || origin === null) return
      record(text, at)
    },
    /** The view has started: steps from now on are recorded. */
    get running() {
      return enabled && origin !== null
    },
    /** The trace stopped or could not start because of `reason`. */
    restart(reason: string) {
      if (!enabled || origin === null) return
      restarts.set(reason, (restarts.get(reason) ?? 0) + 1)
      changed()
    },
    /** The view settled: the whole timeline is logged too. */
    settled() {
      if (!enabled || origin === null) return
      record('settled')
      console.info(text())
    },
    text,
    stop() {
      origin = null
      for (const observer of observers) observer.disconnect()
      observers = []
      if (frame) cancelAnimationFrame(frame)
      frame = 0
    },
  }
  return stats
}

export const bootStats = createBootStats(
  typeof window !== 'undefined' &&
    new URLSearchParams(window.location.search).get('bootStats') === '1',
  typeof document !== 'undefined' ? document : null,
)

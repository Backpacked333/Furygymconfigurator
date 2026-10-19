import { perfEnabled, usePerf } from './perf'

const ms = (v: number | null) => (v === null ? '–' : `${v.toFixed(1)} ms`)

/** The `?debug=perf` overlay: tier, frame times, scene size, governor decisions. */
export function PerfHud() {
  if (!perfEnabled()) return null
  return <PerfPanel />
}

function PerfPanel() {
  const p = usePerf()
  return (
    <pre
      style={{
        position: 'fixed',
        left: 8,
        bottom: 8,
        zIndex: 1000,
        margin: 0,
        padding: '6px 8px',
        font: '11px/1.4 ui-monospace, monospace',
        color: '#fff',
        background: 'rgba(0,0,0,.72)',
        borderRadius: 6,
        pointerEvents: 'none',
      }}
    >
      {[
        `tier ${p.quality ?? '–'}`,
        `motion ${ms(p.intervals.motion)} (${p.frames.motion} frames)`,
        `rest ${ms(p.intervals.rest)} (${p.frames.rest} frames)`,
        `${(p.triangles / 1000).toFixed(0)}k triangles · ${p.calls} calls`,
        ...p.decisions.slice(-3),
      ].join('\n')}
    </pre>
  )
}

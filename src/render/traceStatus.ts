import { useSyncExternalStore } from 'react'

/**
 * Live path-tracing progress, kept outside React state so the status badge can update several
 * times a second without re-rendering the 3D scene tree. Free of three.js imports.
 */
export type TraceState = 'off' | 'preparing' | 'tracing' | 'converged'
export type TraceStatus = {
  state: TraceState
  /** Samples per pixel reached by every pixel. */
  samples: number
  /** Samples per pixel the current pass is refining toward. */
  target: number
  /** True while an exported still is waiting on the tracer. */
  exporting: boolean
}

const OFF: TraceStatus = { state: 'off', samples: 0, target: 0, exporting: false }
let current = OFF
const listeners = new Set<() => void>()

export function setTraceStatus(next: TraceStatus) {
  if (
    next.state === current.state &&
    next.samples === current.samples &&
    next.target === current.target &&
    next.exporting === current.exporting
  )
    return
  current = next
  listeners.forEach((listener) => listener())
}

export function traceStatus() {
  return current
}

function subscribe(listener: () => void) {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

export function useTraceStatus() {
  return useSyncExternalStore(subscribe, traceStatus, traceStatus)
}

/** `?trace=0` or `?trace=1` overrides the default, which follows the device's quality tier. */
export function requestedTrace(search = window.location.search): boolean | null {
  const value = new URLSearchParams(search).get('trace')
  return value === '1' || value === 'on' ? true : value === '0' || value === 'off' ? false : null
}

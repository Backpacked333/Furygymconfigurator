import { useSyncExternalStore } from 'react'
import type { AngleId, AspectClass } from './gallery'
import type { Tier } from './plan'

/**
 * The gallery's stills as the stage and the filmstrip see them, published by the 3D view
 * (RenderEffects with StillSession), and the option whose still is on its way, for the ring on
 * its swatch (ConfigPanel). Kept outside React state and free of three.js imports, like
 * traceStatus.ts, so the app shell reads it without re-rendering the 3D scene tree.
 */

/** A still image: its tier, its address, the samples it was traced with, and its pixel width. */
export type StillImage = { tier: Tier; url: string; samples?: number; width?: number }
/** An angle's images of the design: a thumbnail, and the best still (or export) for the stage. */
export type AngleImages = { thumb?: StillImage; still?: StillImage }
/**
 * How far the current angle's still is: estimated from the cloud's earlier frames (start and
 * expected duration, in performance.now() milliseconds), or measured by a tracer on this device.
 */
export type StillProgress =
  | { kind: 'estimate'; startedAt: number; expectedMs: number }
  | { kind: 'measured'; fraction: number; remainingMs: number | null }

export type StillsSnapshot = {
  /** Who renders stills now: the cloud, this device's tracer, or no one (the live view shows). */
  source: 'cloud' | 'local' | null
  /** The design these images are of (stillKey.ts configKey); empty until the scene has one. */
  design: string
  aspect: AspectClass | null
  images: Partial<Record<AngleId, AngleImages>>
  /** Angles of `design` still waiting for a still (the stage's) or a thumbnail (the others'). */
  pending: Partial<Record<AngleId, boolean>>
  /** The current angle's still, while it renders. */
  progress: StillProgress | null
}

export const NO_STILLS: StillsSnapshot = {
  source: null,
  design: '',
  aspect: null,
  images: {},
  pending: {},
  progress: null,
}

let snapshot = NO_STILLS
let signature = ''
const listeners = new Set<() => void>()

const sign = (s: StillsSnapshot) =>
  JSON.stringify([
    s.source,
    s.design,
    s.aspect,
    s.images,
    s.pending,
    s.progress?.kind === 'measured'
      ? [
          s.progress.fraction.toFixed(3),
          s.progress.remainingMs === null ? null : Math.ceil(s.progress.remainingMs / 1000),
        ]
      : s.progress,
  ])

/** Publishes the stills; a snapshot that says nothing new notifies no one. */
export function setStills(next: StillsSnapshot | null) {
  const value = next ?? NO_STILLS
  const signed = sign(value)
  if (signed === signature) return
  signature = signed
  snapshot = value
  listeners.forEach((listener) => listener())
}

export const stills = () => snapshot

function subscribe(listener: () => void) {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

export function useStills() {
  return useSyncExternalStore(subscribe, stills, stills)
}

/** A configuration option whose still is on its way: the field changed and its new value. */
export type PendingChoice = { field: string; value: string } | null
let choice: PendingChoice = null
const choiceListeners = new Set<() => void>()

export function setPendingChoice(next: PendingChoice) {
  if (next?.field === choice?.field && next?.value === choice?.value) return
  choice = next
  choiceListeners.forEach((listener) => listener())
}

const pendingChoice = () => choice

function subscribeChoice(listener: () => void) {
  choiceListeners.add(listener)
  return () => {
    choiceListeners.delete(listener)
  }
}

/** The option the visitor chose whose still is rendering, or null. */
export function usePendingChoice() {
  return useSyncExternalStore(subscribeChoice, pendingChoice, pendingChoice)
}

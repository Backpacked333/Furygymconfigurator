import { useEffect, useRef } from 'react'
import { useFrame, useThree } from '@react-three/fiber'
import { Quaternion, Vector3, type WebGPURenderer } from 'three/webgpu'
import { Convergence } from './convergence'
import { FrameGovernor, type Verdict } from './governor'
import { perf, perfEnabled } from './perf'
import { createMotionPipeline, createPipeline, type Pipeline } from './pipeline'
import { sceneChanges, sceneProgress, viewerMotion } from './progress'
import type { Quality } from './quality'
import { FRAME_BEGIN, beginFrame } from './renderer'
import { invalidateShadows, refreshShadows } from './shadows'
import type { TierSpec } from './tiers'

/**
 * Camera motion below OrbitControls' own change threshold (squared distance and quaternion terms of
 * 1e-6) is not motion: damping keeps nudging the camera by such amounts after an orbit, and
 * restarting convergence for each nudge would keep the GPU busy long after anything visibly moved.
 */
const STILL = 1e-6

/**
 * While the camera moves, the light motion pipeline draws; this long after it stops, the tier's
 * full pipeline takes over and converges: smooth while dragging, sharp at rest.
 */
export const REFINE_AFTER_MS = 120

/**
 * Drives rendering on demand. Interactive, every moving frame is drawn by the motion pipeline
 * (dragging, damping, auto-rotation, transitions), and the full pipeline only draws at rest, for
 * a short convergence run. Frame intervals feed the governor, which asks for another tier when
 * this device draws this one too slowly, or comfortably fast.
 */
export function RenderLoop({
  quality,
  spec,
  interactive = false,
  promote = false,
  onCaptureReady,
  onVerdict,
}: {
  quality: Quality
  spec: TierSpec
  /** The camera is the user's to move: draw motion with the motion pipeline. */
  interactive?: boolean
  /** Whether a fast device may be promoted to the next tier. */
  promote?: boolean
  onCaptureReady?: (capture: (() => string) | null) => void
  /** Called at most once per tier when the governor decides. */
  onVerdict?: (verdict: Exclude<Verdict, null>) => void
}) {
  const { gl, scene, camera, invalidate } = useThree()
  const renderer = gl as unknown as WebGPURenderer
  const pipeline = useRef<Pipeline | null>(null)
  const converge = useRef(new Convergence(spec.settleFrames))
  const motion = useRef<{ pipeline: Pipeline; warmed: boolean } | null>(null)
  const lastMove = useRef(-Infinity)
  const lastView = useRef({ position: new Vector3(Infinity, 0, 0), quaternion: new Quaternion() })
  const governor = useRef<FrameGovernor | null>(null)
  const timing = useRef({
    last: 0,
    kind: '' as '' | 'motion' | 'rest',
    frames: 0,
    eventful: false,
    continues: false,
  })
  const verdict = useRef(onVerdict)
  verdict.current = onVerdict
  const tracing = perfEnabled()
  useEffect(() => {
    if (tracing) perf.tier(quality)
  }, [tracing, quality])

  useEffect(() => {
    const created = createPipeline(renderer, scene, camera, spec)
    pipeline.current = created
    converge.current = new Convergence(created.settleFrames)
    converge.current.restart()
    governor.current = new FrameGovernor(quality, { promote })
    timing.current = { last: 0, kind: '', frames: 0, eventful: false, continues: false }
    invalidateShadows(scene)
    invalidate()
    return () => {
      pipeline.current = null
      created.dispose()
    }
  }, [renderer, scene, camera, spec, quality, promote, invalidate])

  // The motion pipeline. Its shaders compile under the first refined frame (see below), so the
  // first drag never stalls on them. Lite's own pipeline is already as light as motion needs.
  useEffect(() => {
    if (!interactive || !spec.ao) return
    const created = createMotionPipeline(renderer, scene, camera, spec)
    motion.current = { pipeline: created, warmed: false }
    return () => {
      motion.current = null
      created.dispose()
    }
  }, [renderer, scene, camera, spec, interactive])

  useEffect(
    () =>
      sceneChanges.subscribe((change) => {
        converge.current.change(change)
        invalidate()
      }),
    [invalidate],
  )

  useEffect(() => {
    if (!onCaptureReady) return
    onCaptureReady(() => {
      beginFrame(renderer)
      refreshShadows(scene)
      pipeline.current?.render()
      return renderer.domElement.toDataURL('image/png')
    })
    // A capture must never read the canvas of a renderer that is gone.
    return () => onCaptureReady(null)
  }, [renderer, scene, onCaptureReady])

  // Before every other frame subscriber: camera controls, environment and probe captures, the pipeline.
  useFrame(() => beginFrame(renderer), FRAME_BEGIN)

  /**
   * Back-to-back frames of one kind measure what this GPU sustains. A frame after an idle gap, the
   * first frames of a new pipeline, and eventful frames (shader compiles, shadow redraws, uploads)
   * with the frame after them are one-off work, not the cost of the tier.
   */
  const measure = (kind: 'motion' | 'rest', eventful: boolean, continues: boolean) => {
    const t = timing.current
    const end = performance.now()
    const steady = t.continues && t.kind === kind && !eventful && !t.eventful
    const counted = steady && !!t.last && ++t.frames > 4
    if (counted) {
      const v = governor.current?.sample(kind, end - t.last)
      if (v) {
        if (tracing) perf.decide(`${v} from ${quality} (${kind} frames)`)
        verdict.current?.(v)
      }
    }
    if (tracing) perf.frame(kind, renderer.info.render, counted ? end - t.last : undefined)
    t.eventful = eventful
    t.kind = kind
    t.last = end
    t.continues = continues
  }

  useFrame(() => {
    const active = pipeline.current
    if (!active) return
    const c = converge.current
    const last = lastView.current
    const moved =
      last.position.distanceToSquared(camera.position) > STILL ||
      8 * (1 - Math.abs(last.quaternion.dot(camera.quaternion))) > STILL
    if (moved) {
      c.change('camera')
      last.position.copy(camera.position)
      last.quaternion.copy(camera.quaternion)
    }
    // Nothing asked for convergence (a plain invalidate): one frame of the full pipeline.
    if (!c.settling) c.remaining = 1
    const now = performance.now()
    if (moved) lastMove.current = now
    const fast = motion.current
    const eventful = refreshShadows(scene)
    if (fast && now - lastMove.current < REFINE_AFTER_MS) {
      viewerMotion.active = true
      try {
        fast.pipeline.render()
      } finally {
        viewerMotion.active = false
      }
      sceneProgress.drawn()
      measure('motion', eventful || !fast.warmed, true)
      fast.warmed = true
      // Keeps drawing until the refine delay has passed, then the full tier takes over.
      invalidate()
      return
    }
    const compiles = !!fast && !fast.warmed
    if (fast && compiles) {
      // Draw the motion pipeline once, under this frame, to compile its shaders ahead of a drag.
      fast.warmed = true
      fast.pipeline.render()
    }
    active.render()
    sceneProgress.drawn()
    const more = c.drawn()
    if (more) invalidate()
    // A single-pass tier draws motion with its own pipeline: frames while the camera moves are
    // motion frames for the governor, and the controls keep requesting them back to back.
    const moving = now - lastMove.current < REFINE_AFTER_MS
    measure(moving ? 'motion' : 'rest', eventful || compiles, more || moving)
  }, 1)
  return null
}

import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { bakedStill, forgetBaked } from '../lib/bakedStills'
import { DEFAULT_CAMERA, type Config } from '../lib/config'
import { LoadingExperience } from './LoadingExperience'
import {
  ASPECT_RATIO,
  GALLERY_ANGLES,
  angleKey,
  type AngleId,
  type AspectClass,
} from '../render/gallery'
import type { StillsSnapshot } from '../render/stillStatus'
import type { Layer } from './stillStageState'
import type { useStillStage } from './useStillStage'

/**
 * A first still still loading after this long gets a quiet loading treatment under it, so a slow
 * connection never leaves the stage a blank box; sooner, it would only flicker.
 */
export const LOADING_SHOWN_MS = 300

/**
 * The stills on the stage: the one shown, the one it replaced fading out under it, and the next
 * one decoding out of sight. Each is one <img> from decoding to fading out (keyed by address), so
 * the swap paints an image the browser has already decoded. A baked still comes in several widths
 * for the browser to choose from; the page's first one is on the stage from the first render and
 * shows once it has decoded (`loading`), never a part of it. Entering the 360° view they stay over
 * the live canvas until it has settled, then lift off it together (`lifting`).
 */
export function StillLayers({
  stage,
  label,
  lifting = false,
  config,
}: {
  stage: ReturnType<typeof useStillStage>
  /** What the still shows, for its alternative text. */
  label: string
  lifting?: boolean
  config?: Config
}) {
  const { state, dispatch } = stage
  // Decoded before it is seen: the still waiting to replace the one shown, or the first one.
  const decoding = state.pending ?? (state.loading ? state.shown : null)
  const refs = useRef(new Map<string, HTMLImageElement>())
  // The page's first still, preloaded by index.html, is usually in by the time the stage mounts:
  // shown before the browser paints at all (decoded as it is painted), so the first frame drawn
  // has it, not the empty stage for a frame while it decodes.
  const firstUrl = state.loading ? state.shown?.url : undefined
  useLayoutEffect(() => {
    if (!firstUrl) return
    const image = refs.current.get(firstUrl)
    if (image?.complete && image.naturalWidth > 0) dispatch({ type: 'decoded', url: firstUrl })
  }, [firstUrl, dispatch])
  useEffect(() => {
    if (!decoding) return
    const done = new AbortController()
    const { signal } = done
    const image = refs.current.get(decoding.url)
    const decodedNow = () => !signal.aborted && dispatch({ type: 'decoded', url: decoding.url })
    const failed = () => {
      if (signal.aborted) return
      // A baked still that cannot be loaded is rendered like any other from now on.
      if (decoding.srcset) forgetBaked(decoding.url)
      dispatch({ type: 'failed', url: decoding.url })
    }
    const decoded = image?.decode ? image.decode() : Promise.resolve()
    decoded.then(decodedNow, () => {
      if (signal.aborted) return
      if (image?.complete && image.naturalWidth > 0) return decodedNow()
      // Cut short while it loads (a resize chose another width of it): the image's own load, or
      // its error, says how it ends.
      if (image && !image.complete) {
        image.addEventListener('load', decodedNow, { once: true, signal })
        image.addEventListener('error', failed, { once: true, signal })
        return
      }
      failed()
    })
    return () => done.abort()
  }, [decoding, dispatch])
  // A first still slow to arrive: a quiet treatment shows the stage is on its way.
  const [slow, setSlow] = useState(false)
  useEffect(() => {
    setSlow(false)
    if (!firstUrl) return
    const timer = setTimeout(() => setSlow(true), LOADING_SHOWN_MS)
    return () => clearTimeout(timer)
  }, [firstUrl])
  const pending = state.pending
  const layers: [Layer, string][] = []
  if (state.leaving && state.leaving.url !== state.shown?.url)
    layers.push([state.leaving, 'is-leaving'])
  if (state.shown)
    layers.push([
      state.shown,
      state.loading ? 'is-shown is-loading' : state.fading ? 'is-shown is-entering' : 'is-shown',
    ])
  if (pending) layers.push([pending, 'is-pending'])
  return (
    <div className={`still-layers${lifting ? ' is-lifting' : ''}`}>
      {slow && firstUrl && (
        <div className="still-loading">
          <LoadingExperience
            config={config}
            title="Your view is on its way."
            description="Your design is ready. We’re loading the image at its best quality."
            label="Loading and preparing your image"
          />
        </div>
      )}
      {layers.map(([layer, role]) => (
        <img
          key={layer.url}
          ref={(element) => {
            if (element) refs.current.set(layer.url, element)
            else refs.current.delete(layer.url)
          }}
          className={`still-layer ${role}`}
          src={layer.url}
          srcSet={layer.srcset}
          sizes={layer.sizes}
          alt={role.startsWith('is-shown') ? label : ''}
          aria-hidden={role.startsWith('is-shown') ? undefined : true}
          // The still shown is painted whole: decoded already (pending), or as it is first painted
          // (the page's first, which index.html preloads at the same priority).
          decoding={role.startsWith('is-shown') ? 'sync' : 'async'}
          fetchPriority={role.includes('is-loading') ? 'high' : undefined}
          draggable={false}
          data-tier={layer.tier}
          data-angle={layer.angle}
          data-baked={layer.srcset ? '' : undefined}
        />
      ))}
    </div>
  )
}

/**
 * The nine angles under the stage, as thumbnails of the design: a click puts that angle on the
 * stage. An angle whose still for the design is on its way keeps its last image, shimmering; one
 * baked ahead of time (bakedStills.ts) shows its baked image from the first render.
 */
export function Filmstrip({
  design,
  angle,
  aspect,
  hero = DEFAULT_CAMERA,
  snapshot,
  stagePending,
  onPick,
}: {
  design: string
  angle: AngleId
  aspect: AspectClass
  /** The direction of the front three-quarter view (gallery.ts angleKey). */
  hero?: [number, number, number]
  snapshot: StillsSnapshot
  /** The stage's angle is waiting for its still. */
  stagePending: boolean
  onPick: (angle: AngleId) => void
}) {
  const ready = snapshot.design === design && snapshot.aspect === aspect
  // The last image each angle showed, of this stage shape: held while the next one renders.
  const held = useRef<{ aspect: AspectClass; urls: Partial<Record<AngleId, string>> }>({
    aspect,
    urls: {},
  })
  if (held.current.aspect !== aspect) held.current = { aspect, urls: {} }
  const ratio = ASPECT_RATIO[aspect]
  return (
    <nav className={`filmstrip is-${aspect}`} aria-label="Camera angles">
      {GALLERY_ANGLES.map(({ id, label, group }, i) => {
        const images = ready ? snapshot.images[id] : undefined
        const baked = bakedStill(design, angleKey(id, hero), aspect)
        const fresh = baked?.thumb ?? images?.thumb?.url ?? images?.still?.url
        if (fresh) held.current.urls[id] = fresh
        const url = fresh ?? held.current.urls[id]
        const waiting =
          id === angle
            ? stagePending
            : !baked && snapshot.source === 'cloud' && (!ready || snapshot.pending[id] === true)
        const first = i > 0 && GALLERY_ANGLES[i - 1].group !== group
        return (
          <button
            key={id}
            className={`film-tile${id === angle ? ' is-current' : ''}${waiting ? ' is-pending' : ''}${first ? ' starts-group' : ''}`}
            aria-pressed={id === angle}
            aria-label={`${label} ${group === 'interior' ? 'interior' : 'exterior'} view${waiting ? ', rendering' : ''}`}
            onClick={() => onPick(id)}
          >
            <span className="film-thumb" style={{ aspectRatio: String(ratio) }}>
              {url && <img src={url} alt="" draggable={false} />}
            </span>
            <span className="film-label">{label}</span>
          </button>
        )
      })}
    </nav>
  )
}

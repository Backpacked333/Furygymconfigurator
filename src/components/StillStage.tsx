import { useEffect, useRef } from 'react'
import { ASPECT_RATIO, GALLERY_ANGLES, type AngleId, type AspectClass } from '../render/gallery'
import type { StillsSnapshot } from '../render/stillStatus'
import type { Layer } from './stillStageState'
import type { useStillStage } from './useStillStage'

/**
 * The stills on the stage: the one shown, the one it replaced fading out under it, and the next
 * one decoding out of sight. Each is one <img> from decoding to fading out (keyed by address), so
 * the swap paints an image the browser has already decoded.
 */
export function StillLayers({
  stage,
  label,
}: {
  stage: ReturnType<typeof useStillStage>
  /** What the still shows, for its alternative text. */
  label: string
}) {
  const { state, dispatch } = stage
  const pending = state.pending
  const refs = useRef(new Map<string, HTMLImageElement>())
  useEffect(() => {
    if (!pending) return
    let alive = true
    const image = refs.current.get(pending.url)
    const decoding = image?.decode ? image.decode() : Promise.resolve()
    decoding.then(
      () => alive && dispatch({ type: 'decoded', url: pending.url }),
      () => alive && dispatch({ type: 'failed', url: pending.url }),
    )
    return () => {
      alive = false
    }
  }, [pending, dispatch])
  const layers: [Layer, string][] = []
  if (state.leaving && state.leaving.url !== state.shown?.url)
    layers.push([state.leaving, 'is-leaving'])
  if (state.shown) layers.push([state.shown, state.fading ? 'is-shown is-entering' : 'is-shown'])
  if (pending) layers.push([pending, 'is-pending'])
  return (
    <div className="still-layers">
      {layers.map(([layer, role]) => (
        <img
          key={layer.url}
          ref={(element) => {
            if (element) refs.current.set(layer.url, element)
            else refs.current.delete(layer.url)
          }}
          className={`still-layer ${role}`}
          src={layer.url}
          alt={role.startsWith('is-shown') ? label : ''}
          aria-hidden={role.startsWith('is-shown') ? undefined : true}
          decoding="async"
          draggable={false}
          data-tier={layer.tier}
          data-angle={layer.angle}
        />
      ))}
    </div>
  )
}

/**
 * The nine angles under the stage, as thumbnails of the design: a click puts that angle on the
 * stage. An angle whose still for the design is on its way keeps its last image, shimmering.
 */
export function Filmstrip({
  design,
  angle,
  aspect,
  snapshot,
  stagePending,
  onPick,
}: {
  design: string
  angle: AngleId
  aspect: AspectClass
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
        const fresh = images?.thumb?.url ?? images?.still?.url
        if (fresh) held.current.urls[id] = fresh
        const url = fresh ?? held.current.urls[id]
        const waiting =
          id === angle
            ? stagePending
            : snapshot.source === 'cloud' && (!ready || snapshot.pending[id] === true)
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

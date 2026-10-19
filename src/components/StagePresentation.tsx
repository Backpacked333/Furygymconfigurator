import type { CSSProperties, ImgHTMLAttributes, ReactNode, Ref } from 'react'

export type StageAspect = 'wide' | 'tall'

/** The same fitted image frame in either route. Rendering/decoding is supplied by adapters. */
export function StageFrame({
  aspect,
  covered = false,
  box,
  frameRef,
  children,
}: {
  aspect: StageAspect
  covered?: boolean
  box?: CSSProperties | null
  frameRef?: Ref<HTMLDivElement>
  children: ReactNode
}) {
  return (
    <div className="stage-frame" ref={frameRef}>
      <div
        className={`still-stage is-${aspect}${covered ? ' is-covered' : ''}`}
        style={box ?? undefined}
      >
        {children}
      </div>
    </div>
  )
}

export type StageImageLayer = {
  key: string
  role: string
  ref?: Ref<HTMLImageElement>
  image: ImgHTMLAttributes<HTMLImageElement>
  tier?: string
  angle?: string
  baked?: boolean
}

/** Neutral, keyed image layers: the legacy adapter still owns decode/fade/baked lifecycle. */
export function StageImageLayers({
  layers,
  lifting = false,
  busy,
  current,
  previous,
  loading,
  children,
}: {
  layers: readonly StageImageLayer[]
  lifting?: boolean
  busy: boolean
  current: boolean
  previous?: ReactNode
  loading?: ReactNode
  children?: ReactNode
}) {
  return (
    <div
      className={`still-layers${lifting ? ' is-lifting' : ''}`}
      aria-busy={busy}
      data-current={current}
    >
      {previous && (
        <span className="still-previous-label" role="status">
          {previous}
        </span>
      )}
      {loading && (
        <div className="still-loading" role="status">
          <span>{loading}</span>
        </div>
      )}
      {layers.map((layer) => (
        <img
          {...layer.image}
          key={layer.key}
          ref={layer.ref}
          className={`still-layer ${layer.role}${layer.image.className ? ` ${layer.image.className}` : ''}`}
          draggable={false}
          data-tier={layer.tier}
          data-angle={layer.angle}
          data-baked={layer.baked ? '' : undefined}
        />
      ))}
      {children}
    </div>
  )
}

export type StageFilmstripItem<Id extends string> = {
  id: Id
  label: string
  accessibleLabel: string
  group: string
  waiting?: boolean
  url?: string
  /** Honest placeholder when no thumbnail of this view exists (not a recycled photo). */
  placeholder?: ReactNode
}

export function StageFilmstrip<Id extends string>({
  items,
  selected,
  aspect,
  onPick,
  label = 'Camera angles',
}: {
  items: readonly StageFilmstripItem<Id>[]
  selected: Id
  aspect: StageAspect
  onPick: (id: Id) => void
  label?: string
}) {
  const ratio = aspect === 'wide' ? 16 / 10 : 4 / 5
  return (
    <nav className={`filmstrip is-${aspect}`} aria-label={label}>
      {items.map((item, index) => (
        <button
          key={item.id}
          className={`film-tile${item.id === selected ? ' is-current' : ''}${item.waiting ? ' is-pending' : ''}${index > 0 && items[index - 1].group !== item.group ? ' starts-group' : ''}`}
          aria-pressed={item.id === selected}
          aria-label={item.accessibleLabel}
          onClick={() => onPick(item.id)}
        >
          <span className="film-thumb" style={{ aspectRatio: String(ratio) }}>
            {item.url ? <img src={item.url} alt="" draggable={false} /> : item.placeholder}
          </span>
          <span className="film-label">{item.label}</span>
        </button>
      ))}
    </nav>
  )
}

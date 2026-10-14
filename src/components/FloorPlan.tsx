import { useEffect, useId, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react'
import { ArrowDown, ArrowLeft, ArrowRight, ArrowUp, Move, RotateCw, Trash2 } from 'lucide-react'
import {
  catalogItem,
  configSchema,
  distance,
  placementIssue,
  productName,
  type Config,
  type PlacedItem,
  type Unit,
} from '../lib/config'
import { type EditResult, type EditToken } from '../lib/editTransactions'
import { occupiedEnvelope, spatialContract, workingEnvelope, type Bounds3 } from '../lib/spatial'

export type EditInteractionProps = {
  revision?: number
  interactionKey?: string | number
  interactionDisabled?: boolean
  onBeginEdit?: () => EditToken
  onPreviewEdit?: (token: EditToken, config: Config) => EditResult | void
  onCommitEdit?: (token: EditToken, config?: Config) => EditResult | void
  onCancelEdit?: (token?: EditToken) => EditResult | void
}
type Gesture = {
  base: Config
  candidate: Config
  published: Config
  revision?: number
  key?: string | number
  token?: EditToken
  id: string
  keys: Set<string>
  pointer?: {
    id: number
    x: number
    y: number
    dx: number
    dz: number
    target: SVGSVGElement | null
  }
}
const moved = (a: PlacedItem, b: PlacedItem) =>
  a.x !== b.x || a.z !== b.z || a.rotation !== b.rotation
const arrows = new Set(['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'])
const rectangle = (b: Bounds3) => ({
  x: b.min.x,
  y: b.min.z,
  width: b.max.x - b.min.x,
  height: b.max.z - b.min.z,
})

export default function FloorPlan(
  props: {
    config: Config
    unit: Unit
    onChange: (c: Config) => void
    notify: (text: string) => void
    repairWorkspace?: boolean
  } & EditInteractionProps,
) {
  const { config, unit, interactionDisabled = false, repairWorkspace = false } = props
  const latest = useRef(props)
  latest.current = props
  const svg = useRef<SVGSVGElement>(null)
  const grid = useId()
  const statusId = useId()
  const [selected, setSelected] = useState<string | null>(null)
  const [ghost, setGhost] = useState<PlacedItem | null>(null)
  const [status, setStatus] = useState('')
  const [showElevated, setShowElevated] = useState(true)
  const [showContext, setShowContext] = useState(true)
  const gesture = useRef<Gesture | null>(null)
  const current = config.items.find((i) => i.id === selected)
  const blocked = () =>
    latest.current.interactionDisabled || !!document.querySelector('dialog[open]')
  const report = (message: string) => {
    setStatus(message)
    latest.current.notify(message)
  }
  const release = (g: Gesture) => {
    if (g.pointer?.target?.hasPointerCapture?.(g.pointer.id))
      g.pointer.target.releasePointerCapture(g.pointer.id)
  }
  const cancel = () => {
    const g = gesture.current
    gesture.current = null
    if (g?.token) latest.current.onCancelEdit?.(g.token)
    if (g) release(g)
    setGhost(null)
  }
  const cancelRef = useRef(cancel)
  cancelRef.current = cancel
  const validBase = (g: Gesture) => {
    const p = latest.current
    return (
      !blocked() &&
      g.revision === p.revision &&
      g.key === p.interactionKey &&
      p.config.items.some((item) => item.id === g.id) &&
      [JSON.stringify(g.base), JSON.stringify(g.published)].includes(JSON.stringify(p.config))
    )
  }
  useEffect(() => {
    if (gesture.current && !validBase(gesture.current)) cancelRef.current()
  })
  useEffect(() => {
    const stop = () => cancelRef.current()
    const hidden = () => {
      if (document.hidden) stop()
    }
    window.addEventListener('blur', stop)
    window.addEventListener('fury:modal-open', stop)
    document.addEventListener('visibilitychange', hidden)
    return () => {
      window.removeEventListener('blur', stop)
      window.removeEventListener('fury:modal-open', stop)
      document.removeEventListener('visibilitychange', hidden)
      stop()
    }
  }, [])
  const start = (item: PlacedItem): Gesture => ({
    base: latest.current.config,
    candidate: latest.current.config,
    published: latest.current.config,
    revision: latest.current.revision,
    key: latest.current.interactionKey,
    id: item.id,
    keys: new Set(),
  })
  const preview = (g: Gesture, item: PlacedItem) => {
    if (!validBase(g)) {
      cancel()
      return
    }
    const original = g.base.items.find((i) => i.id === g.id)!
    const candidate = moved(original, item)
      ? {
          ...g.base,
          package: 'custom' as const,
          items: g.base.items.map((i) => (i.id === item.id ? item : i)),
        }
      : g.base
    const p = latest.current
    if (
      !g.token &&
      moved(original, item) &&
      p.onBeginEdit &&
      p.onPreviewEdit &&
      p.onCommitEdit &&
      p.onCancelEdit
    )
      g.token = p.onBeginEdit()
    g.candidate = candidate
    setGhost(item)
    const issue = placementIssue(item, candidate)
    setStatus(
      issue
        ? `${repairWorkspace ? 'Repair preview' : 'Invalid preview'}: ${issue}`
        : 'Preview only. Release to apply; Escape cancels.',
    )
    if (g.token && configSchema.safeParse(candidate).success) {
      g.published = candidate
      const result = p.onPreviewEdit?.(g.token, candidate)
      if (result?.status === 'conflict' || result?.status === 'rejected') {
        cancel()
        report(result.issues.join(' '))
      }
    }
  }
  const finish = () => {
    const g = gesture.current
    if (!g) return
    if (!validBase(g)) {
      cancel()
      return
    }
    const item = g.candidate.items.find((i) => i.id === g.id)!
    const original = g.base.items.find((i) => i.id === g.id)!
    const issue = placementIssue(item, g.candidate)
    if (!moved(original, item) || (issue && !latest.current.repairWorkspace)) {
      cancel()
      if (issue) report(issue)
      else setStatus('No position change.')
      return
    }
    gesture.current = null
    release(g)
    setGhost(null)
    const result = g.token
      ? latest.current.onCommitEdit?.(g.token, g.candidate)
      : latest.current.onChange(g.candidate)
    if (result?.status === 'conflict' || result?.status === 'rejected')
      report(result.issues.join(' '))
    else
      report(
        issue
          ? `Repair change applied. Remaining issue: ${issue}`
          : `${catalogItem(item.sku).name} position updated.`,
      )
  }
  const single = (id: string, transform: (item: PlacedItem) => PlacedItem) => {
    if (blocked()) return
    const active = gesture.current
    if (active && !validBase(active)) {
      cancel()
      return
    }
    const p = latest.current
    const base = active?.base ?? p.config
    cancel()
    const original = base.items.find((i) => i.id === id)
    if (!original) return
    const item = transform(original)
    if (!moved(original, item)) return
    const candidate = {
      ...base,
      package: 'custom' as const,
      items: base.items.map((i) => (i.id === id ? item : i)),
    }
    const issue = placementIssue(item, candidate)
    if (issue && !p.repairWorkspace) {
      report(issue)
      return
    }
    const token = p.onBeginEdit && p.onCommitEdit && p.onCancelEdit ? p.onBeginEdit() : undefined
    const result = token ? p.onCommitEdit?.(token, candidate) : p.onChange(candidate)
    if (result?.status === 'rejected' || result?.status === 'conflict')
      report(result.issues.join(' '))
    else
      report(
        issue
          ? `Repair change applied. Remaining issue: ${issue}`
          : `${catalogItem(item.sku).name} position updated.`,
      )
  }
  const remove = (id: string) => {
    if (blocked()) return
    const active = gesture.current
    if (active && !validBase(active)) {
      cancel()
      return
    }
    const base = active?.base ?? latest.current.config
    cancel()
    const p = latest.current
    const index = base.items.findIndex((i) => i.id === id)
    if (index < 0) return
    const candidate = {
      ...base,
      package: 'custom' as const,
      items: base.items.filter((i) => i.id !== id),
    }
    const token = p.onBeginEdit && p.onCommitEdit && p.onCancelEdit ? p.onBeginEdit() : undefined
    const result = token ? p.onCommitEdit?.(token, candidate) : p.onChange(candidate)
    if (result?.status === 'rejected' || result?.status === 'conflict') {
      report(result.issues.join(' '))
      return
    }
    const next = candidate.items[Math.min(index, candidate.items.length - 1)]?.id ?? null
    setSelected(next)
    const elements = svg.current?.querySelectorAll<SVGGElement>('[data-item-id]')
    const focus = Array.from(elements ?? []).find((el) => el.dataset.itemId === next)
    ;(focus ?? svg.current)?.focus()
    report('Item removed. Undo restores it.')
  }
  const point = (e: PointerEvent) => {
    const matrix = svg.current?.getScreenCTM()
    return matrix ? new DOMPoint(e.clientX, e.clientY).matrixTransform(matrix.inverse()) : null
  }
  const keyboard = (e: KeyboardEvent<SVGGElement>, item: PlacedItem) => {
    if (blocked() || e.altKey || e.ctrlKey || e.metaKey) return
    if (e.key === 'Escape') {
      e.preventDefault()
      cancel()
      setStatus('Edit cancelled.')
      return
    }
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault()
      setSelected(item.id)
      return
    }
    if (arrows.has(e.key)) {
      e.preventDefault()
      if (gesture.current?.pointer || (e.repeat && !gesture.current)) return
      setSelected(item.id)
      const g = gesture.current ?? start(item)
      gesture.current = g
      g.keys.add(e.key)
      const shown = g.candidate.items.find((i) => i.id === item.id)!
      const step = e.shiftKey ? 1 : 0.25
      preview(g, {
        ...shown,
        x: shown.x + (e.key === 'ArrowRight' ? step : e.key === 'ArrowLeft' ? -step : 0),
        z: shown.z + (e.key === 'ArrowDown' ? step : e.key === 'ArrowUp' ? -step : 0),
      })
    } else if (!e.repeat && e.key.toLowerCase() === 'r') {
      e.preventDefault()
      single(item.id, (original) => ({ ...original, rotation: original.rotation === 0 ? 90 : 0 }))
    } else if (!e.repeat && (e.key === 'Delete' || e.key === 'Backspace')) {
      e.preventDefault()
      remove(item.id)
    }
  }
  const space = spatialContract(config)
  const zones = [...space.external, ...space.openings, ...space.overhead].filter(
    (zone) => showElevated || zone.bounds.min.y <= space.finishedFloor,
  )
  const context = showContext ? space.context : []
  const allBounds = [
    space.usable,
    space.entrance.bounds,
    ...zones.map((z) => z.bounds),
    ...context.map((z) => z.bounds),
    ...(space.openingTravel ? [space.openingTravel.bounds] : []),
  ]
  const minX = Math.min(-config.length / 2, ...allBounds.map((b) => b.min.x)) - 3.2
  const maxX = Math.max(config.length / 2, ...allBounds.map((b) => b.max.x)) + 2
  const minZ = Math.min(-4, ...allBounds.map((b) => b.min.z)) - 3
  const maxZ = Math.max(4, ...allBounds.map((b) => b.max.z)) + 2
  const unitScale = unit === 'm' ? 0.3048 : 1
  return (
    <div className="floor-plan">
      <div className="plan-heading">
        <span className="eyebrow">A PLACE FOR EVERYTHING</span>
        <h2>Make room for your ritual.</h2>
        <p>Drag or select an item. Arrow keys move; Shift moves 1′. Escape cancels.</p>
      </div>
      <div className="plan-layers" aria-label="Plan layers">
        <label>
          <input
            type="checkbox"
            checked={showElevated}
            onChange={(e) => setShowElevated(e.target.checked)}
          />{' '}
          Elevated structure
        </label>
        {space.context.length > 0 && (
          <label>
            <input
              type="checkbox"
              checked={showContext}
              onChange={(e) => setShowContext(e.target.checked)}
            />{' '}
            Site context · inquiry only
          </label>
        )}
      </div>
      <svg
        ref={svg}
        className="plan-svg"
        viewBox={`${minX} ${minZ} ${maxX - minX} ${maxZ - minZ}`}
        role="group"
        tabIndex={-1}
        aria-label={`Editable ${productName(config)} floor plan`}
        aria-describedby={statusId}
        onPointerMove={(e) => {
          const g = gesture.current
          if (!g?.pointer || g.pointer.id !== e.pointerId) return
          if (
            Math.hypot(e.clientX - g.pointer.x, e.clientY - g.pointer.y) < 4 &&
            !g.token &&
            g.candidate === g.base
          )
            return
          const p = point(e)
          if (!p) return
          const item = g.base.items.find((i) => i.id === g.id)!
          preview(g, {
            ...item,
            x: Math.round((p.x - g.pointer.dx) * 4) / 4,
            z: Math.round((p.y - g.pointer.dz) * 4) / 4,
          })
        }}
        onPointerUp={(e) => {
          if (gesture.current?.pointer?.id === e.pointerId) finish()
        }}
        onPointerCancel={(e) => {
          if (gesture.current?.pointer?.id === e.pointerId) cancel()
        }}
        onLostPointerCapture={(e) => {
          if (gesture.current?.pointer?.id === e.pointerId) cancel()
        }}
      >
        <defs>
          <pattern id={grid} width="1" height="1" patternUnits="userSpaceOnUse">
            <path d="M 1 0 L 0 0 0 1" fill="none" stroke="#d0d3c5" strokeWidth="0.018" />
          </pattern>
        </defs>
        {context.map((zone) => (
          <g key={zone.id} data-context-id={zone.id} className="plan-context">
            <title>{zone.label}</title>
            <rect {...rectangle(zone.bounds)} />
            <text
              x={(zone.bounds.min.x + zone.bounds.max.x) / 2}
              y={zone.bounds.max.z - 0.5}
              textAnchor="middle"
              fontSize="0.32"
            >
              {zone.id === 'sunken-lounge' ? 'LOUNGE' : 'WELLNESS'} · SITE INQUIRY ONLY
            </text>
          </g>
        ))}
        <rect
          x={-config.length / 2}
          y={-4}
          width={config.length}
          height="8"
          rx={config.family === 'studio' ? 0.6 : 0.05}
          fill="#29342c"
        />
        <rect {...rectangle(space.usable)} rx="0.12" fill="#e8e9dc" />
        <rect {...rectangle(space.usable)} fill={`url(#${grid})`} />
        {zones.map((zone) => (
          <g
            key={zone.id}
            data-zone-id={zone.id}
            data-elevation={zone.bounds.min.y}
            className={`plan-zone ${zone.bounds.min.y > space.finishedFloor ? 'elevated' : ''}`}
          >
            <title>
              {zone.label}. Elevation {distance(zone.bounds.min.y, unit)}–
              {distance(zone.bounds.max.y, unit)} above ground.
            </title>
            <rect {...rectangle(zone.bounds)} />
          </g>
        ))}
        <g className="plan-advisory" data-zone-id="entry">
          <title>{space.entrance.label}</title>
          <rect {...rectangle(space.entrance.bounds)} />
        </g>
        {space.openingTravel && (
          <g className="plan-travel" data-zone-id={space.openingTravel.id}>
            <title>{space.openingTravel.label}</title>
            <rect {...rectangle(space.openingTravel.bounds)} />
          </g>
        )}
        <path
          d={`M ${-config.length / 2} -5.1 H ${config.length / 2} M ${-config.length / 2} -5.4 V -4.8 M ${config.length / 2} -5.4 V -4.8`}
          fill="none"
          stroke="#7d8771"
          strokeWidth="0.035"
        />
        <text x="0" y="-5.5" textAnchor="middle" fontSize="0.45" fill="#35422e">
          {distance(config.length, unit)} exterior
        </text>
        <text
          x={-config.length / 2 - 1.2}
          y="0"
          textAnchor="middle"
          fontSize="0.4"
          fill="#35422e"
          transform={`rotate(-90 ${-config.length / 2 - 1.2} 0)`}
        >
          {distance(8, unit)} exterior
        </text>
        {config.items.map((item) => {
          const shown = ghost?.id === item.id ? ghost : item
          const b = occupiedEnvelope(shown),
            product = catalogItem(item.sku),
            active = selected === item.id
          const invalid =
            ghost?.id === item.id &&
            placementIssue(shown, {
              ...config,
              items: config.items.map((i) => (i.id === shown.id ? shown : i)),
            })
          return (
            <g
              key={item.id}
              tabIndex={interactionDisabled ? -1 : 0}
              role="button"
              aria-disabled={interactionDisabled}
              data-item-id={item.id}
              aria-label={`${product.name}. Position ${distance(shown.x, unit)}, ${distance(shown.z, unit)}. Arrow keys move, R rotates, Delete removes.`}
              aria-pressed={active}
              className={`plan-item ${active ? 'selected' : ''} ${invalid ? 'invalid' : ''}`}
              onKeyDown={(e) => keyboard(e, item)}
              onKeyUp={(e) => {
                const g = gesture.current
                if (g && !g.pointer && g.keys.delete(e.key)) {
                  e.preventDefault()
                  if (!g.keys.size) finish()
                }
              }}
              onBlur={() => {
                if (gesture.current?.id === item.id) cancel()
              }}
              onClick={() => {
                if (!blocked()) setSelected(item.id)
              }}
              onPointerDown={(e) => {
                if (blocked() || e.button !== 0 || e.isPrimary === false || gesture.current) return
                const p = point(e)
                if (!p) return
                e.preventDefault()
                e.currentTarget.focus()
                setSelected(item.id)
                const g = start(item)
                g.pointer = {
                  id: e.pointerId,
                  x: e.clientX,
                  y: e.clientY,
                  dx: p.x - item.x,
                  dz: p.y - item.z,
                  target: svg.current,
                }
                gesture.current = g
                svg.current?.setPointerCapture?.(e.pointerId)
              }}
            >
              {active && (
                <rect
                  {...rectangle(workingEnvelope(shown))}
                  className="plan-working"
                  pointerEvents="none"
                >
                  <title>{product.clearanceLabel}</title>
                </rect>
              )}
              <rect
                {...rectangle(b)}
                className="plan-occupied"
                rx="0.12"
                fill={invalid ? '#efc0b5' : active ? '#cbdc9f' : '#c7ccb9'}
                stroke={invalid ? '#9c3a2a' : active ? '#61753b' : '#8a9680'}
                strokeWidth={active ? 0.07 : 0.035}
              />
              <text
                x={(b.min.x + b.max.x) / 2}
                y={(b.min.z + b.max.z) / 2}
                textAnchor="middle"
                fontSize={Math.min(0.3, (b.max.x - b.min.x) / 8)}
                fill="#38462d"
                pointerEvents="none"
              >
                {product.name}
              </text>
              {invalid && (
                <text
                  x={b.min.x + 0.12}
                  y={b.min.z + 0.35}
                  fontSize="0.3"
                  fill="#9c3a2a"
                  pointerEvents="none"
                >
                  !
                </text>
              )}
            </g>
          )
        })}
      </svg>
      <div className="plan-toolbar" aria-label="Selected equipment controls">
        {current ? (
          <>
            <strong>{catalogItem(current.sku).name}</strong>
            <div className="plan-nudge" role="group" aria-label="Move selected item by 3 inches">
              {[
                { label: 'left', x: -0.25, z: 0, Icon: ArrowLeft },
                { label: 'back', x: 0, z: -0.25, Icon: ArrowUp },
                { label: 'front', x: 0, z: 0.25, Icon: ArrowDown },
                { label: 'right', x: 0.25, z: 0, Icon: ArrowRight },
              ].map(({ label, x, z, Icon }) => (
                <button
                  key={label}
                  disabled={interactionDisabled}
                  aria-label={`Move ${label} 3 inches`}
                  onClick={() =>
                    single(current.id, (original) => ({
                      ...original,
                      x: original.x + x,
                      z: original.z + z,
                    }))
                  }
                >
                  <Icon size={17} />
                </button>
              ))}
            </div>
            <button
              disabled={interactionDisabled}
              onClick={() =>
                single(current.id, (original) => ({
                  ...original,
                  rotation: original.rotation === 0 ? 90 : 0,
                }))
              }
            >
              <RotateCw size={15} /> Rotate
            </button>
            <button disabled={interactionDisabled} onClick={() => remove(current.id)}>
              <Trash2 size={15} /> Remove
            </button>
            <form
              key={`${current.id}:${current.x}:${current.z}:${unit}`}
              className="plan-coordinates"
              onSubmit={(e) => {
                e.preventDefault()
                const data = new FormData(e.currentTarget),
                  x = Number(data.get('x')) / unitScale,
                  z = Number(data.get('z')) / unitScale
                if (Number.isFinite(x) && Number.isFinite(z))
                  single(current.id, (original) => ({
                    ...original,
                    x: Math.round(x * 4) / 4,
                    z: Math.round(z * 4) / 4,
                  }))
              }}
            >
              <label>
                X ({unit})
                <input
                  name="x"
                  type="number"
                  step="any"
                  required
                  defaultValue={Number((current.x * unitScale).toFixed(4))}
                  disabled={interactionDisabled}
                />
              </label>
              <label>
                Z ({unit})
                <input
                  name="z"
                  type="number"
                  step="any"
                  required
                  defaultValue={Number((current.z * unitScale).toFixed(4))}
                  disabled={interactionDisabled}
                />
              </label>
              <button disabled={interactionDisabled} type="submit">
                Apply position
              </button>
            </form>
          </>
        ) : (
          <span>
            <Move size={15} /> Select equipment · 3-inch snap grid
          </span>
        )}
      </div>
      <p id={statusId} className="plan-status" role="status" aria-live="polite">
        {status ||
          (repairWorkspace
            ? 'Repair workspace: edits stay suspended until explicitly accepted.'
            : 'Selection does not change your design.')}
      </p>
      <details className="plan-legend">
        <summary>Plan layers + elevations</summary>
        <p>
          Solid outlines: modeled occupied bounds. Purple dashed: elevated structure. Green dashed:
          advisory working / entry space. Amber dotted: illustrative opening travel. Site context is
          inquiry only, never bundled product scope.
        </p>
        <ul>
          {[...space.external, ...space.overhead].map((zone) => (
            <li key={zone.id}>
              {zone.label}: {distance(zone.bounds.min.y, unit)}–{distance(zone.bounds.max.y, unit)}{' '}
              above ground
            </li>
          ))}
        </ul>
      </details>
      <p className="plan-disclaimer">
        Concept layout, not a safety certification. Dashed working zones are illustrative; confirm
        manufacturer clearances, access, and installation requirements. Finished floor:{' '}
        {distance(space.finishedFloor, unit)} above ground.
      </p>
    </div>
  )
}

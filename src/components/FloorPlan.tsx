import { useRef, useState, type KeyboardEvent, type PointerEvent } from 'react'
import { Move, RotateCw, Trash2 } from 'lucide-react'
import {
  catalogItem,
  distance,
  footprint,
  placementIssue,
  type Config,
  type PlacedItem,
  type Unit,
} from '../lib/config'

export default function FloorPlan({
  config,
  unit,
  onChange,
  notify,
}: {
  config: Config
  unit: Unit
  onChange: (c: Config) => void
  notify: (text: string) => void
}) {
  const svg = useRef<SVGSVGElement>(null)
  const [selected, setSelected] = useState<string | null>(null)
  const [ghost, setGhost] = useState<PlacedItem | null>(null)
  const drag = useRef<{ id: string; dx: number; dz: number } | null>(null)
  const current = config.items.find((i) => i.id === selected)
  const point = (e: PointerEvent) => {
    const matrix = svg.current?.getScreenCTM()
    if (!matrix) return { x: 0, y: 0 }
    return new DOMPoint(e.clientX, e.clientY).matrixTransform(matrix.inverse())
  }
  const commit = (item: PlacedItem) => {
    const issue = placementIssue(item, config)
    if (issue) {
      notify(issue)
      return
    }
    onChange({
      ...config,
      package: 'custom',
      items: config.items.map((i) => (i.id === item.id ? item : i)),
    })
  }
  const keyboard = (e: KeyboardEvent<SVGGElement>, item: PlacedItem) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault()
      setSelected(item.id)
      return
    }
    const step = e.shiftKey ? 1 : 0.25
    if (e.key.startsWith('Arrow')) {
      e.preventDefault()
      setSelected(item.id)
      commit({
        ...item,
        x: item.x + (e.key === 'ArrowRight' ? step : e.key === 'ArrowLeft' ? -step : 0),
        z: item.z + (e.key === 'ArrowDown' ? step : e.key === 'ArrowUp' ? -step : 0),
      })
    }
    if (e.key.toLowerCase() === 'r') {
      e.preventDefault()
      commit({ ...item, rotation: item.rotation === 0 ? 90 : 0 })
    }
    if (e.key === 'Delete' || e.key === 'Backspace') {
      e.preventDefault()
      onChange({
        ...config,
        package: 'custom',
        items: config.items.filter((i) => i.id !== item.id),
      })
      setSelected(null)
    }
  }
  return (
    <div className="floor-plan">
      <div className="plan-heading">
        <span className="eyebrow">A PLACE FOR EVERYTHING</span>
        <h2>Make room for your ritual.</h2>
        <p>Drag to arrange. Select an item to rotate or remove.</p>
      </div>
      <svg
        ref={svg}
        className="plan-svg"
        viewBox={`${-config.length / 2 - 3.2} -7.5 ${config.length + 6.4} 15.5`}
        role="group"
        aria-label="Editable studio floor plan"
        onPointerMove={(e) => {
          if (!drag.current) return
          const item = config.items.find((i) => i.id === drag.current!.id)
          if (!item) return
          const p = point(e)
          setGhost({
            ...item,
            x: Math.round((p.x - drag.current.dx) * 4) / 4,
            z: Math.round((p.y - drag.current.dz) * 4) / 4,
          })
        }}
        onPointerUp={(e) => {
          if (ghost) commit(ghost)
          drag.current = null
          setGhost(null)
          if (svg.current?.hasPointerCapture(e.pointerId))
            svg.current.releasePointerCapture(e.pointerId)
        }}
        onPointerCancel={() => {
          drag.current = null
          setGhost(null)
        }}
      >
        <defs>
          <pattern id="floor-grid" width="1" height="1" patternUnits="userSpaceOnUse">
            <path d="M 1 0 L 0 0 0 1" fill="none" stroke="#d0d3c5" strokeWidth="0.018" />
          </pattern>
        </defs>
        <rect
          x={-config.length / 2}
          y={-4}
          width={config.length}
          height="8"
          rx="0.6"
          fill="#29342c"
        />
        <rect
          x={-config.length / 2 + 0.45}
          y={-3.55}
          width={config.length - 0.9}
          height="7.1"
          rx="0.16"
          fill="#e8e9dc"
        />
        <rect
          x={-config.length / 2 + 0.7}
          y={-3.35}
          width={config.length - 1.4}
          height="6.7"
          fill="url(#floor-grid)"
        />
        <path
          d={`M ${-config.length / 2 + 0.8} 3.85 H ${config.length / 2 - 0.8}`}
          stroke="#abc2b1"
          strokeWidth="0.12"
        />
        <rect x="-1.6" y="2.3" width="3.2" height="1.7" fill="#ced8b8" opacity="0.7" />
        <path
          d="M -1.6 4 V 2.4 H 1.6 V 4"
          fill="none"
          stroke="#788d66"
          strokeWidth="0.045"
          strokeDasharray="0.16 0.12"
        />
        <text x="0" y="4.9" textAnchor="middle" fontSize="0.28" fill="#6c7462" letterSpacing="0.09">
          ENTRY / KEEP CLEAR
        </text>
        <path
          d={`M ${-config.length / 2} -5.1 H ${config.length / 2} M ${-config.length / 2} -5.4 V -4.8 M ${config.length / 2} -5.4 V -4.8`}
          fill="none"
          stroke="#7d8771"
          strokeWidth="0.035"
        />
        <text x="0" y="-5.5" textAnchor="middle" fontSize="0.45" fill="#35422e">
          {distance(config.length, unit)}
        </text>
        <path d={`M ${-config.length / 2 - 1.1} -4 V 4`} stroke="#7d8771" strokeWidth="0.035" />
        <text
          x={-config.length / 2 - 1.6}
          y="0"
          textAnchor="middle"
          fontSize="0.4"
          fill="#35422e"
          transform={`rotate(-90 ${-config.length / 2 - 1.6} 0)`}
        >
          {distance(8, unit)}
        </text>
        {config.items.map((item) => {
          const shown = ghost?.id === item.id ? ghost : item,
            f = footprint(shown),
            product = catalogItem(item.sku)
          const active = selected === item.id,
            invalid = ghost?.id === item.id && placementIssue(shown, config)
          return (
            <g
              key={item.id}
              transform={`translate(${shown.x} ${shown.z})`}
              tabIndex={0}
              role="button"
              aria-label={`${product.name}. Position ${distance(shown.x, unit)}, ${distance(shown.z, unit)}. Arrow keys move, R rotates, Delete removes.`}
              aria-pressed={active}
              className="plan-item"
              onKeyDown={(e) => keyboard(e, item)}
              onPointerDown={(e) => {
                e.preventDefault()
                setSelected(item.id)
                const p = point(e)
                drag.current = { id: item.id, dx: p.x - item.x, dz: p.y - item.z }
                setGhost(item)
                svg.current?.setPointerCapture(e.pointerId)
              }}
            >
              {active && (
                <rect
                  x={-f.w / 2 - product.clearance}
                  y={-f.d / 2 - product.clearance}
                  width={f.w + product.clearance * 2}
                  height={f.d + product.clearance * 2}
                  rx="0.15"
                  fill="#91a863"
                  fillOpacity="0.08"
                  stroke="#8b9e70"
                  strokeWidth="0.025"
                  strokeDasharray="0.15 0.1"
                  pointerEvents="none"
                />
              )}
              <rect
                x={-f.w / 2}
                y={-f.d / 2}
                width={f.w}
                height={f.d}
                rx="0.18"
                fill={invalid ? '#c17869' : active ? '#cbdc9f' : '#c7ccb9'}
                stroke={invalid ? '#9c3a2a' : active ? '#61753b' : '#8a9680'}
                strokeWidth={active ? 0.07 : 0.035}
              />
              <rect
                x={-f.w / 2 + 0.16}
                y={-f.d / 2 + 0.16}
                width={f.w - 0.32}
                height={f.d - 0.32}
                rx="0.1"
                fill="none"
                stroke="#879679"
                strokeWidth="0.025"
              />
              <text
                y="-0.04"
                textAnchor="middle"
                fontSize={Math.min(0.3, f.w / 8)}
                fill="#38462d"
                pointerEvents="none"
              >
                {product.name.split(' ').slice(0, -1).join(' ') || product.name}
              </text>
              <text
                y="0.33"
                textAnchor="middle"
                fontSize={Math.min(0.3, f.w / 8)}
                fill="#38462d"
                pointerEvents="none"
              >
                {product.name.includes(' ') ? product.name.split(' ').at(-1) : ''}
              </text>
              {active && (
                <circle cx={f.w / 2 - 0.13} cy={-f.d / 2 + 0.13} r="0.14" fill="#526735" />
              )}
            </g>
          )
        })}
      </svg>
      <div className="plan-toolbar">
        {current ? (
          <>
            <span>{catalogItem(current.sku).name}</span>
            <button
              onClick={() => commit({ ...current, rotation: current.rotation === 0 ? 90 : 0 })}
            >
              <RotateCw size={15} /> Rotate
            </button>
            <button
              onClick={() => {
                onChange({
                  ...config,
                  package: 'custom',
                  items: config.items.filter((i) => i.id !== current.id),
                })
                setSelected(null)
              }}
            >
              <Trash2 size={15} /> Remove
            </button>
          </>
        ) : (
          <span>
            <Move size={15} /> Snap-to-grid · 3-inch increments
          </span>
        )}
      </div>
      <p className="plan-disclaimer">
        Concept layout, not a safety certification. Dashed zones are illustrative working space;
        confirm manufacturer clearances, access, and installation requirements.
      </p>
    </div>
  )
}

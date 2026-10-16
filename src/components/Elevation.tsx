import type { ReactNode } from 'react'
import {
  FINISHES,
  catalogItem,
  footprint,
  openingGeometry,
  productHeight,
  studioBays,
  studioDoorBay,
  type Config,
  type PlacedItem,
} from '../lib/config'

/** Interior wall color seen through the glazing, per interior style. */
const INTERIOR_TONE: Record<Config['interiorStyle'], string> = {
  gallery: '#e8e6e0',
  slatted: '#dcd6ca',
  timber: '#c58a57',
  birch: '#d6b98f',
}
const SILHOUETTE = '#1d201f'

function luminance(hex: string) {
  const v = parseInt(hex.slice(1), 16)
  return (0.2126 * ((v >> 16) & 255) + 0.7152 * ((v >> 8) & 255) + 0.0722 * (v & 255)) / 255
}

/** A simple equipment glyph in elevation: x is the item center, y the floor line, s px/ft. */
function glyph(item: PlacedItem, x: number, y: number, s: number): ReactNode {
  const p = catalogItem(item.sku)
  const w = footprint(item).w * s,
    h = p.h * s
  const fill = SILHOUETTE
  const post = Math.max(1, 0.22 * s)
  switch (item.sku) {
    case 'rack':
    case 'halfrack':
      return (
        <g key={item.id} fill={fill}>
          <rect x={x - w / 2} y={y - h} width={post} height={h} />
          <rect x={x + w / 2 - post} y={y - h} width={post} height={h} />
          <rect x={x - w / 2} y={y - h} width={w} height={post} />
          <rect x={x - w / 2 - 0.9 * s} y={y - 4.45 * s} width={w + 1.8 * s} height={0.1 * s} />
          <circle cx={x - w / 2 - 0.4 * s} cy={y - 4.45 * s} r={0.7 * s} />
          <circle cx={x + w / 2 + 0.4 * s} cy={y - 4.45 * s} r={0.7 * s} />
        </g>
      )
    case 'trainer':
      return (
        <g key={item.id} fill={fill}>
          <rect x={x - w / 2} y={y - h} width={1.0 * s} height={h} opacity={0.9} />
          <rect x={x + w / 2 - 1.0 * s} y={y - h} width={1.0 * s} height={h} opacity={0.9} />
          <rect x={x - w / 2} y={y - h} width={w} height={post} />
          <rect x={x - w / 2 + 1.4 * s} y={y - h + 0.6 * s} width={post} height={h - 0.8 * s} />
          <rect
            x={x + w / 2 - 1.4 * s - post}
            y={y - h + 0.6 * s}
            width={post}
            height={h - 0.8 * s}
          />
        </g>
      )
    case 'bike':
    case 'airbike': {
      const r = (item.sku === 'airbike' ? 1.05 : 0.75) * s
      return (
        <g key={item.id} fill="none" stroke={fill} strokeWidth={Math.max(1, 0.18 * s)}>
          <circle cx={x - w / 4} cy={y - r - 0.3 * s} r={r} fill={fill} fillOpacity={0.35} />
          <path
            d={`M ${x - w / 4} ${y - r} L ${x + w / 4} ${y - 3 * s} M ${x - w / 4} ${y - 2 * s} L ${x - w / 4 + 0.4 * s} ${y - h}`}
          />
        </g>
      )
    }
    case 'treadmill':
      return (
        <g key={item.id} fill={fill}>
          <rect x={x - w / 2} y={y - 0.5 * s} width={w} height={0.5 * s} />
          <rect x={x - w / 2} y={y - h} width={post} height={h} />
          <rect x={x + w / 2 - post} y={y - h} width={post} height={h} />
          <rect x={x - w / 2} y={y - h} width={w} height={0.6 * s} />
        </g>
      )
    case 'medball':
      return (
        <g key={item.id} fill={fill}>
          <rect x={x - post / 2} y={y - h} width={post} height={h} />
          {[0.62, 1.55, 2.48, 3.41, 4.34].map((b) => (
            <circle key={b} cx={x} cy={y - b * s} r={0.42 * s} />
          ))}
        </g>
      )
    case 'plyo':
      return (
        <g key={item.id} fill={fill}>
          <rect x={x - w / 2} y={y - 1.67 * s} width={2.5 * s} height={1.67 * s} />
          <circle cx={x + w / 2 - 0.9 * s} cy={y - 0.9 * s} r={0.9 * s} opacity={0.5} />
        </g>
      )
    case 'shelf':
      return (
        <g key={item.id} fill="none" stroke={fill} strokeWidth={Math.max(1, 0.12 * s)}>
          <rect x={x - w / 2} y={y - h} width={w} height={h} />
          {[1.5, 3, 4.5].map((t) => (
            <path key={t} d={`M ${x - w / 2} ${y - t * s} H ${x + w / 2}`} />
          ))}
        </g>
      )
    case 'weights':
      return (
        <path
          key={item.id}
          fill={fill}
          d={`M ${x - w / 2} ${y} L ${x - w / 2 + 0.5 * s} ${y - h} H ${x + w / 2 - 0.5 * s} L ${x + w / 2} ${y} Z`}
          opacity={0.85}
        />
      )
    default:
      return (
        <rect
          key={item.id}
          x={x - w / 2}
          y={y - Math.max(h, 0.2 * s)}
          width={w}
          height={Math.max(h, 0.2 * s)}
          rx={0.2 * s}
          fill={fill}
          opacity={0.85}
        />
      )
  }
}

/**
 * Front elevation of a configuration: shell, openings and infill, glazing, additions, and the
 * equipment silhouetted inside, as in the portfolio photographs. Drawn from the same config the
 * 3D scene renders, so thumbnails can never disagree with it.
 */
export function Elevation({ config: c, className }: { config: Config; className?: string }) {
  const L = c.length
  const H = productHeight(c)
  const studio = c.family === 'studio'
  const finish = FINISHES.find((f) => f.id === c.finish)!.color
  const dark = luminance(finish) < 0.3
  const frame = dark ? '#0f1110' : '#141615'
  const roofY = studio ? 10.42 : H + 1.1
  const extraW = c.addons.stairs ? 4.6 : 0
  const extraH = c.addons.roof ? roofY + 3.6 : H + 0.4
  const s = Math.min(176 / (L + extraW + 1), 74 / extraH)
  const ground = 86
  const x0 = 100 - ((L + extraW) * s) / 2
  const X = (ft: number) => x0 + (L / 2 + ft) * s
  const Y = (ft: number) => ground - ft * s
  const tone = INTERIOR_TONE[c.interiorStyle]
  const glass = '#a9bdb6'
  const floorY = Y(0.96)
  const parts: ReactNode[] = []

  if (studio) {
    const base = 0.3
    parts.push(
      <rect
        key="plinth"
        x={X(-L / 2 + 0.7)}
        y={Y(base)}
        width={(L - 1.4) * s}
        height={base * s}
        fill="#151615"
      />,
      <rect
        key="shell"
        x={X(-L / 2)}
        y={Y(base + H)}
        width={L * s}
        height={H * s}
        rx={1.6 * s}
        fill={finish}
      />,
      <rect
        key="interior"
        x={X(-L / 2 + 0.8)}
        y={Y(base + H - 0.8)}
        width={(L - 1.6) * s}
        height={(H - 1.6) * s}
        rx={0.8 * s}
        fill={tone}
      />,
      <rect
        key="glass"
        x={X(-L / 2 + 0.8)}
        y={Y(base + H - 0.8)}
        width={(L - 1.6) * s}
        height={(H - 1.6) * s}
        rx={0.8 * s}
        fill={glass}
        opacity={0.22}
      />,
      <rect
        key="frame"
        x={X(-L / 2 + 0.8)}
        y={Y(base + H - 0.8)}
        width={(L - 1.6) * s}
        height={(H - 1.6) * s}
        rx={0.8 * s}
        fill="none"
        stroke={frame}
        strokeWidth={Math.max(1, 0.16 * s)}
      />,
    )
  } else {
    const opening = openingGeometry(c)
    const left = opening.center - opening.width / 2
    parts.push(
      <rect key="body" x={X(-L / 2)} y={Y(H)} width={L * s} height={H * s} fill={finish} />,
      <rect
        key="interior"
        x={X(left)}
        y={Y(H - 0.9)}
        width={opening.width * s}
        height={(H - 1.5) * s}
        fill={tone}
      />,
    )
    for (let x = -L / 2 + 0.6; x < L / 2 - 0.5; x += 0.91)
      if (x < left - 0.2 || x > left + opening.width + 0.2)
        parts.push(
          <path
            key={`rib${x}`}
            d={`M ${X(x)} ${Y(H - 0.45)} V ${Y(0.5)}`}
            stroke="#000"
            strokeOpacity={0.28}
            strokeWidth={Math.max(0.6, 0.12 * s)}
          />,
        )
    for (const sx of [-1, 1])
      parts.push(
        <rect
          key={`post${sx}`}
          x={X(sx < 0 ? -L / 2 : L / 2 - 0.4)}
          y={Y(H)}
          width={0.4 * s}
          height={H * s}
          fill="#000"
          opacity={0.22}
        />,
      )
    parts.push(
      <rect
        key="rail"
        x={X(-L / 2)}
        y={Y(0.5)}
        width={L * s}
        height={0.5 * s}
        fill="#000"
        opacity={0.18}
      />,
    )
  }

  // Equipment silhouettes stand on the interior floor.
  const equipment = c.items.map((item) => glyph(item, X(item.x), floorY, s))

  // Glazing and infill drawn over the equipment.
  const front: ReactNode[] = []
  if (studio) {
    const { span, count, width } = studioBays(L)
    const door = studioDoorBay(c)
    for (let i = 1; i < count; i++)
      front.push(
        <path
          key={`m${i}`}
          d={`M ${X(-span / 2 + i * width)} ${Y(9.46)} V ${Y(1.26)}`}
          stroke={frame}
          strokeWidth={Math.max(1, 0.14 * s)}
        />,
      )
    const dx = X(-span / 2 + door * width + 0.07)
    front.push(
      <rect
        key="door"
        x={dx}
        y={Y(8.96)}
        width={(width - 0.14) * s}
        height={7.7 * s}
        fill="none"
        stroke={frame}
        strokeWidth={Math.max(1.2, 0.22 * s)}
      />,
    )
  } else {
    const opening = openingGeometry(c)
    const left = opening.center - opening.width / 2
    const head = H - 0.9
    const ox = X(left),
      ow = opening.width * s
    if (c.containerOpening === 'roll-up') {
      const drop = c.doorsOpen ? 1.35 : head - 1.6
      front.push(
        <rect
          key="hood"
          x={ox - 0.25 * s}
          y={Y(head)}
          width={ow + 0.5 * s}
          height={0.85 * s}
          fill={finish}
        />,
      )
      for (let y = 0; y < drop; y += 0.35)
        front.push(
          <rect
            key={`slat${y}`}
            x={ox}
            y={Y(head - 0.78 - y)}
            width={ow}
            height={0.3 * s}
            fill="#c9ccc6"
            opacity={0.9}
          />,
        )
    } else if (c.openingInfill === 'glass-overhead') {
      const doorHead = Math.min(H - 1.9, 7.47)
      front.push(
        <rect
          key="header"
          x={ox}
          y={Y(head)}
          width={ow}
          height={(head - doorHead) * s}
          fill={finish}
        />,
      )
      if (c.doorsOpen)
        front.push(
          <rect
            key="raised"
            x={ox}
            y={Y(doorHead + 0.4)}
            width={ow}
            height={0.3 * s}
            fill={frame}
            opacity={0.7}
          />,
        )
      else {
        const cols = Math.max(2, Math.round(opening.width / 4.6))
        front.push(
          <rect
            key="glass"
            x={ox}
            y={Y(doorHead)}
            width={ow}
            height={(doorHead - 0.62) * s}
            fill={glass}
            opacity={0.3}
          />,
        )
        for (let k = 0; k <= 4; k++)
          front.push(
            <path
              key={`r${k}`}
              d={`M ${ox} ${Y(0.62 + (k * (doorHead - 0.62)) / 4)} h ${ow}`}
              stroke={frame}
              strokeWidth={Math.max(1, 0.17 * s)}
            />,
          )
        for (let k = 0; k <= cols; k++)
          front.push(
            <path
              key={`c${k}`}
              d={`M ${ox + (k * ow) / cols} ${Y(doorHead)} V ${Y(0.62)}`}
              stroke={frame}
              strokeWidth={Math.max(1, 0.15 * s)}
            />,
          )
      }
    } else if (c.openingInfill === 'awning') {
      const count = Math.max(2, Math.round(opening.width / 4.2))
      const sw = ow / count
      for (let k = 0; k < count; k++) {
        const sx = ox + k * sw
        if (c.doorsOpen)
          front.push(
            <path
              key={`sash${k}`}
              d={`M ${sx + 1} ${Y(head)} h ${sw - 2} l ${0.9 * s} ${3.9 * s} h ${-(sw - 2 + 1.8 * s)} Z`}
              fill={glass}
              fillOpacity={0.35}
              stroke={frame}
              strokeWidth={Math.max(1, 0.17 * s)}
            />,
          )
        else
          front.push(
            <rect
              key={`sash${k}`}
              x={sx}
              y={Y(head)}
              width={sw}
              height={(head - 0.62) * s}
              fill={glass}
              fillOpacity={0.3}
              stroke={frame}
              strokeWidth={Math.max(1, 0.17 * s)}
            />,
          )
      }
    }
    front.push(
      <rect
        key="frame"
        x={ox - 0.25 * s}
        y={Y(head + 0.25)}
        width={ow + 0.5 * s}
        height={(head - 0.3) * s}
        fill="none"
        stroke={c.integratedFinish ? finish : '#7f857c'}
        strokeOpacity={0.9}
        strokeWidth={Math.max(1, 0.3 * s)}
      />,
    )
  }

  // Additions.
  const extras: ReactNode[] = []
  if (c.addons.deck)
    extras.push(
      studio ? (
        <rect key="deck" x={X(-L / 2)} y={Y(0.86)} width={L * s} height={0.86 * s} fill="#9b7653" />
      ) : (
        <rect
          key="deck"
          x={X(-L / 2 - 0.1)}
          y={Y(0.5)}
          width={(L + 0.2) * s}
          height={0.5 * s}
          fill="#9b7653"
        />
      ),
    )
  if (c.addons.canopy && !studio)
    extras.push(
      <rect
        key="canopy"
        x={X(-L / 2 - 0.3)}
        y={Y(H + 0.14)}
        width={(L + 0.6) * s}
        height={0.7 * s}
        fill={finish}
        stroke="#000"
        strokeOpacity={0.25}
        strokeWidth={0.6}
      />,
    )
  if (c.addons.roof) {
    const top = roofY
    if (!studio)
      extras.push(
        <rect
          key="fascia"
          x={X(-L / 2 - 0.15)}
          y={Y(top)}
          width={(L + 0.3) * s}
          height={1.1 * s}
          fill="#a77c57"
        />,
      )
    const railH = 3.5 * s
    extras.push(
      c.railing === 'glass' ? (
        <rect
          key="rail"
          x={X(-L / 2 + 0.6)}
          y={Y(top) - railH}
          width={(L - 1.2) * s}
          height={railH}
          fill="#cfe0da"
          fillOpacity={0.35}
          stroke="#9aa3a0"
          strokeWidth={0.8}
        />
      ) : (
        <g key="rail" stroke="#151716" strokeWidth={Math.max(0.8, 0.12 * s)}>
          <path
            d={`M ${X(-L / 2)} ${Y(top) - railH} H ${X(L / 2)}`}
            strokeWidth={Math.max(1.2, 0.2 * s)}
          />
          {Array.from({ length: Math.ceil(L / 4.2) + 1 }, (_, i) => (
            <path
              key={i}
              d={`M ${X(-L / 2 + (i * L) / Math.ceil(L / 4.2))} ${Y(top)} v ${-railH}`}
            />
          ))}
          {[0.25, 0.45, 0.65, 0.85].map((t) => (
            <path
              key={t}
              d={`M ${X(-L / 2)} ${Y(top) - railH * t} H ${X(L / 2)}`}
              stroke="#b7bbbb"
              strokeWidth={0.5}
            />
          ))}
        </g>
      ),
    )
  }
  if (c.addons.stairs) {
    const sx = X(L / 2 + 0.3),
      top = roofY
    const steps = 9
    let d = `M ${sx + 4.2 * s} ${ground}`
    for (let i = 0; i < steps; i++) d += ` v ${(-top * s) / steps} h ${(-3.9 * s) / steps}`
    extras.push(
      <path
        key="stairs"
        d={d}
        fill="none"
        stroke={studio ? '#8b6a4a' : '#151716'}
        strokeWidth={Math.max(1.2, 0.2 * s)}
      />,
    )
  }
  if (c.addons.gazebo && studio)
    extras.push(
      <rect
        key="gazebo"
        x={X(-L / 2) + 3}
        y={Y(10.3) + 3}
        width={L * s}
        height={10 * s}
        rx={1.6 * s}
        fill="none"
        stroke={finish}
        strokeWidth={Math.max(1.5, 0.35 * s)}
        opacity={0.9}
      />,
    )

  return (
    <svg viewBox="0 0 200 92" aria-hidden="true" className={className ?? 'elevation'}>
      <path
        d={`M 6 ${ground + 0.5} H 194`}
        stroke="#8f9a80"
        strokeOpacity={0.45}
        strokeWidth={0.8}
      />
      {parts}
      {equipment}
      {front}
      {extras}
    </svg>
  )
}

import { useId } from 'react'
import { resolveFixedLayoutForReview, type FixedLayout } from '../domain/fixedLayout'
import { arrangementEquipment } from '../domain/arrangements'
import { catalogItem, distance, type Unit } from '../lib/config'

export function FixedPlan({
  layout,
  unit,
  halos,
}: {
  layout: FixedLayout
  unit: Unit
  halos: boolean
}) {
  const id = useId()
  const resolved = resolveFixedLayoutForReview(layout)
  const length = layout.product.lengthFt
  const labelScale = length === 40 ? 1.6 : 1
  return (
    <figure className="review-plan">
      <div
        className="review-plan-scroll"
        tabIndex={0}
        role="region"
        aria-label="Scrollable read-only floor plan"
      >
        <svg
          style={{ minWidth: length === 40 ? 720 : 480 }}
          viewBox={`${-length / 2 - 3} -7 ${length + 6} 15`}
          role="img"
          aria-labelledby={`${id}-title ${id}-description`}
        >
          <title id={`${id}-title`}>
            {layout.product.family} {length} ft fixed arrangement
          </title>
          <desc id={`${id}-description`}>
            Read-only schematic with {resolved.items.length} numbered equipment footprints, matching
            the inventory below. Openings and exercise-use clearances are unresolved. No placement,
            rotation or removal controls.
          </desc>
          <defs>
            <pattern id={`${id}-grid`} width={1} height={1} patternUnits="userSpaceOnUse">
              <path d="M 1 0 L 0 0 0 1" fill="none" stroke="#dedfd7" strokeWidth="0.02" />
            </pattern>
          </defs>
          <rect x={-length / 2} y={-4} width={length} height={8} rx="0.15" fill="#d4d6cc" />
          <rect x={-length / 2 + 0.7} y={-3.35} width={length - 1.4} height={6.7} fill="#f6f7f0" />
          <rect
            x={-length / 2 + 0.7}
            y={-3.35}
            width={length - 1.4}
            height={6.7}
            fill={`url(#${id}-grid)`}
          />
          <path
            d={`M ${-length / 2} -5.2 H ${length / 2} M ${-length / 2} -5.5 v .6 M ${length / 2} -5.5 v .6`}
            stroke="#7d857a"
            strokeWidth="0.03"
          />
          <text x={0} y={-5.65} textAnchor="middle" fontSize={0.48 * labelScale} fill="#344139">
            {distance(length, unit)}
          </text>
          <text
            x={-length / 2 - 1.4}
            y={0}
            textAnchor="middle"
            fontSize={0.4 * labelScale}
            fill="#344139"
            transform={`rotate(-90 ${-length / 2 - 1.4} 0)`}
          >
            {distance(8, unit)}
          </text>
          {resolved.items.map((item, index) => {
            const dimensions = arrangementEquipment(item.sku)
            const w = item.rotation === 90 ? dimensions.depthFt : dimensions.occupiedWidthFt
            const d = item.rotation === 90 ? dimensions.occupiedWidthFt : dimensions.depthFt
            const clearance = dimensions.illustrativeClearanceFt
            return (
              <g
                key={item.id}
                transform={`translate(${item.x} ${item.z})`}
                data-equipment={item.sku}
              >
                <title>
                  {index + 1}. {catalogItem(item.sku).name}
                </title>
                {halos && (
                  <rect
                    x={-w / 2 - clearance}
                    y={-d / 2 - clearance}
                    width={w + 2 * clearance}
                    height={d + 2 * clearance}
                    fill="#a44f2420"
                    stroke="#a44f24"
                    strokeWidth="0.04"
                    strokeDasharray="0.15 0.12"
                  />
                )}
                <rect
                  x={-w / 2}
                  y={-d / 2}
                  width={w}
                  height={d}
                  rx="0.1"
                  fill="#31483e"
                  stroke="#1d3026"
                  strokeWidth="0.035"
                />
                <circle r={0.37 * labelScale} fill="#f6f7f0" />
                <text
                  y={0.13 * labelScale}
                  textAnchor="middle"
                  fontSize={0.36 * labelScale}
                  fontWeight="700"
                  fill="#23392d"
                >
                  {index + 1}
                </text>
              </g>
            )
          })}
          <text
            x={0}
            y={5.3}
            textAnchor="middle"
            fontSize={0.34 * labelScale}
            letterSpacing="0.04"
            fill="#526053"
          >
            SCHEMATIC ENVELOPE · OPENINGS NOT RESOLVED
          </text>
        </svg>
      </div>
      <figcaption>
        Generic catalog footprints, not manufacturer CAD. The rack footprint includes its loaded
        bar.{' '}
        {halos
          ? 'Amber halos are illustrative only; wall crossings are unresolved conflicts.'
          : 'A clear-looking plan is not an approved use or access zone.'}
      </figcaption>
    </figure>
  )
}

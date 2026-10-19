import { ScanLine } from 'lucide-react'
import {
  PACKAGES,
  catalogItem,
  configItems,
  distance,
  footprint,
  entryCenter,
  openingGeometry,
  productName,
  type Config,
  type Unit,
} from '../lib/config'

/** The chosen planning package drawn to scale: a reference drawing, not an editor. */
export default function FloorPlan({ config, unit }: { config: Config; unit: Unit }) {
  const items = configItems(config)
  const pkg = PACKAGES.find((p) => p.id === config.package)!
  return (
    <div className="floor-plan">
      <div className="plan-heading">
        <span className="eyebrow">A PLACE FOR EVERYTHING</span>
        <h2>Make room for your ritual.</h2>
        <p>
          {pkg.name} planning package · {items.length} items. Choose another package under Interior.
        </p>
      </div>
      <svg
        className="plan-svg"
        viewBox={`${-config.length / 2 - 3.2} -7.5 ${config.length + 6.4} 15.5`}
        role="img"
        aria-label={`${productName(config)} floor plan with the ${pkg.name} planning package`}
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
          d={
            config.family === 'container'
              ? `M ${openingGeometry(config).center - openingGeometry(config).width / 2} 3.85 h ${openingGeometry(config).width}`
              : `M ${-config.length / 2 + 0.8} 3.85 H ${config.length / 2 - 0.8}`
          }
          stroke="#abc2b1"
          strokeWidth="0.12"
        />
        <g transform={`translate(${entryCenter(config)} 0)`}>
          <rect x="-1.6" y="2.3" width="3.2" height="1.7" fill="#ced8b8" opacity="0.7" />
          <path
            d="M -1.6 4 V 2.4 H 1.6 V 4"
            fill="none"
            stroke="#788d66"
            strokeWidth="0.045"
            strokeDasharray="0.16 0.12"
          />
          <text
            x="0"
            y="4.9"
            textAnchor="middle"
            fontSize="0.28"
            fill="#6c7462"
            letterSpacing="0.09"
          >
            ENTRY / KEEP CLEAR
          </text>
        </g>
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
        {items.map((item) => {
          const f = footprint(item),
            product = catalogItem(item.sku)
          return (
            <g key={item.id} transform={`translate(${item.x} ${item.z})`} className="plan-item">
              <rect
                x={-f.w / 2 - product.clearance}
                y={-f.d / 2 - product.clearance}
                width={f.w + product.clearance * 2}
                height={f.d + product.clearance * 2}
                rx="0.15"
                fill="#91a863"
                fillOpacity="0.06"
                stroke="#8b9e70"
                strokeWidth="0.02"
                strokeDasharray="0.15 0.1"
              />
              <rect
                x={-f.w / 2}
                y={-f.d / 2}
                width={f.w}
                height={f.d}
                rx="0.18"
                fill="#c7ccb9"
                stroke="#8a9680"
                strokeWidth={0.035}
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
              <text y="-0.04" textAnchor="middle" fontSize={Math.min(0.3, f.w / 8)} fill="#38462d">
                {product.name.split(' ').slice(0, -1).join(' ') || product.name}
              </text>
              <text y="0.33" textAnchor="middle" fontSize={Math.min(0.3, f.w / 8)} fill="#38462d">
                {product.name.includes(' ') ? product.name.split(' ').at(-1) : ''}
              </text>
            </g>
          )
        })}
      </svg>
      <div className="plan-toolbar">
        <span>
          <ScanLine size={15} />{' '}
          {items.map((i) => catalogItem(i.sku).name).join(' · ') || 'Open floor'}
        </span>
      </div>
      <p className="plan-disclaimer">
        Concept layout, not a safety certification. Dashed zones are illustrative working space;
        confirm manufacturer clearances, access, and installation requirements.
      </p>
    </div>
  )
}

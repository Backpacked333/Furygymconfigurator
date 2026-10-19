import {
  ArrowDownRight,
  ArrowRight,
  Check,
  ChevronDown,
  Dumbbell,
  Flame,
  Building2,
  Fence,
  Footprints,
  Heart,
  Layers3,
  Leaf,
  Moon,
  Plus,
  ScanLine,
  Sun,
  TreePine,
  Waves,
  Wind,
} from 'lucide-react'
import {
  ADDONS,
  ENVIRONMENTS,
  FINISHES,
  FLOORS,
  PACKAGES,
  area,
  distance,
  layoutIssues,
  money,
  configItems,
  setAddon,
  setFamily,
  productHeight,
  type Config,
  type PackageId,
  type Unit,
} from '../lib/config'
import { QUALITY_DETAILS, type Quality } from '../render/quality'
import {
  PRODUCT_FAMILIES,
  CONTAINER_OPENINGS,
  STUDIO_LAYOUTS,
  PRODUCT_SOURCE_DATE,
  productFamily,
} from '../lib/products'

const STEPS = ['Space', 'Exterior', 'Interior', 'Setting']

/** Day or blue-hour night. The studio backdrop is always lit like a photo studio. */
export function LightingControl({
  config: c,
  onChange,
}: {
  config: Config
  onChange: (c: Config) => void
}) {
  const studio = c.environment === 'studio'
  return (
    <div className="segmented lighting-control" role="group" aria-label="Lighting">
      {(['day', 'night'] as const).map((lighting) => {
        const Icon = lighting === 'day' ? Sun : Moon
        const active = studio ? lighting === 'day' : c.lighting === lighting
        return (
          <button
            key={lighting}
            className={active ? 'active' : ''}
            aria-pressed={active}
            disabled={studio}
            title={studio ? 'The studio backdrop is always lit like a photo studio.' : undefined}
            onClick={() => onChange({ ...c, lighting })}
          >
            <Icon size={14} /> {lighting === 'day' ? 'Day' : 'Night'}
          </button>
        )
      })}
    </div>
  )
}
export function MiniStudio({
  finish = '#353c33',
  long = false,
  deck = false,
  family = 'studio',
}: {
  finish?: string
  long?: boolean
  deck?: boolean
  family?: Config['family']
}) {
  return (
    <svg viewBox="0 0 180 86" aria-hidden="true" className="mini-studio">
      <path d="M 20 69 L 128 80 L 172 57 L 62 49 Z" fill="#a6a993" opacity=".2" />
      {deck && <path d="M 27 62 L 132 73 L 158 60 L 52 49 Z" fill="#a08a65" />}
      <path
        d={`M 30 27 L ${long ? 157 : 140} 35 L ${long ? 157 : 140} 63 L 30 54 Z`}
        fill={finish}
      />
      <path d="M 30 27 L 55 14 L 165 24 L 140 35 Z" fill={finish} />
      <path d="M 140 35 L 165 24 L 165 51 L 140 63 Z" fill={finish} />
      {family === 'studio' ? (
        <path d="M 35 31 L 136 39 L 136 58 L 35 50 Z" fill="#afbfac" opacity=".65" />
      ) : (
        <path d="M 69 34 L 109 38 L 109 57 L 69 53 Z" fill="#151c18" />
      )}
      {[53, 73, 94, 115].map((x) => (
        <path
          key={x}
          d={`M ${x} ${32 + (x - 35) * 0.08} V ${50 + (x - 35) * 0.08}`}
          stroke={finish}
          strokeWidth="2"
        />
      ))}
      <path
        d="M 145 37 L 160 30 M145 41L160 34 M145 45L160 38 M145 49L160 42 M145 53L160 46"
        stroke="#b9a07c"
        strokeWidth="1.5"
      />
    </svg>
  )
}
function Toggle({
  label,
  detail,
  checked,
  onChange,
}: {
  label: string
  detail?: string
  checked: boolean
  onChange: () => void
}) {
  return (
    <button className="toggle-row" role="switch" aria-checked={checked} onClick={onChange}>
      <span>
        <strong>{label}</strong>
        {detail && <small>{detail}</small>}
      </span>
      <span className={`switch ${checked ? 'on' : ''}`} aria-hidden="true">
        <span />
      </span>
    </button>
  )
}
const packageIcons = {
  strength: Dumbbell,
  recovery: Waves,
  movement: Wind,
  cardio: Heart,
  empty: ScanLine,
}

export default function ConfigPanel({
  config: c,
  onChange,
  step,
  setStep,
  unit,
  setUnit,
  quality,
  setQuality,
  notify,
  onPlan,
  onTemplate,
}: {
  config: Config
  onChange: (c: Config) => void
  step: number
  setStep: (step: number) => void
  unit: Unit
  setUnit: (u: Unit) => void
  quality: Quality
  setQuality: (q: Quality) => void
  notify: (message: string) => void
  onPlan: () => void
  onTemplate: (id: 'athlete' | 'retreat' | 'flow') => void
}) {
  const product = productFamily(c.family)
  const applyPackage = (id: PackageId) => {
    const next = { ...c, package: id }
    if (layoutIssues(next).length) {
      notify('This planning layout does not keep the selected entry clear.')
      return
    }
    onChange(next)
  }
  return (
    <aside className="config-panel" aria-label="Gym configuration">
      <div className="panel-tabs" role="tablist" aria-label="Configuration steps">
        {STEPS.map((label, i) => (
          <button
            key={label}
            role="tab"
            id={`step-${i}`}
            aria-selected={step === i}
            aria-controls="step-content"
            tabIndex={step === i ? 0 : -1}
            onClick={() => setStep(i)}
            onKeyDown={(e) => {
              if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
                e.preventDefault()
                const next = (step + (e.key === 'ArrowRight' ? 1 : -1) + 4) % 4
                setStep(next)
                document.getElementById(`step-${next}`)?.focus()
              }
            }}
          >
            <span>0{i + 1}</span>
            {label}
          </button>
        ))}
      </div>
      <div
        className="panel-scroll"
        role="tabpanel"
        id="step-content"
        aria-labelledby={`step-${step}`}
        key={step}
      >
        {step === 0 && (
          <>
            <div className="panel-title">
              <span className="eyebrow">FURY CO GYMS / PORTABLE UNITS</span>
              <h2>
                Your space.
                <br />
                Your way to train.
              </h2>
              <p>
                Purpose-built for your practice.
                <br />
                Designed to feel entirely yours.
              </p>
            </div>
            <div className="section-label">Choose your product family</div>
            <div className="family-options" role="group" aria-label="Product family">
              {PRODUCT_FAMILIES.map((family) => (
                <button
                  key={family.id}
                  className={`family-card ${c.family === family.id ? 'selected' : ''}`}
                  aria-pressed={c.family === family.id}
                  onClick={() => {
                    const next = setFamily(c, family.id)
                    if (layoutIssues(next).length) {
                      notify(
                        'Rearrange equipment to keep the new entry clear before changing family.',
                      )
                      return
                    }
                    onChange(next)
                    if (c.family !== family.id)
                      notify(
                        `${family.name} selected. Studio-only additions and custom requests are cleared when switching to Containers. Undo restores the previous design.`,
                      )
                  }}
                >
                  <strong>{family.name}</strong>
                  <small>{family.description}</small>
                  <span>Family from {money(family.startingPrice)}</span>
                </button>
              ))}
            </div>
            <p className="muted small">
              Published family starting prices—not a price for this size or configuration. All
              selections require a quote.
            </p>
            <a className="source-link" href={product.source} target="_blank" rel="noreferrer">
              Official {product.shortName} specifications ↗
            </a>
            <div className="section-label">
              Choose your footprint <span>01 / 02</span>
            </div>
            <div className="size-options">
              {([20, 40] as const).map((length) => (
                <button
                  className={`size-card ${c.length === length ? 'selected' : ''}`}
                  key={length}
                  aria-pressed={c.length === length}
                  onClick={() => {
                    const updated = { ...c, length }
                    if (layoutIssues(updated).length) {
                      notify(
                        'Your equipment needs more room. Rearrange or remove items in the floor plan before choosing 20 feet.',
                      )
                      return
                    }
                    onChange(updated)
                  }}
                >
                  <div className="size-card-top">
                    <span>
                      {length}′ {product.shortName}
                    </span>
                    <span className="selection-dot">
                      {c.length === length && <Check size={11} />}
                    </span>
                  </div>
                  <MiniStudio long={length === 40} family={c.family} />
                  <div className="size-card-bottom">
                    <strong>{distance(length, unit)} footprint</strong>
                    <small>
                      {area(length * 8, unit)} · {length === 20 ? 'Focused' : 'Expansive'}
                    </small>
                  </div>
                </button>
              ))}
            </div>
            <div className="spec-strip">
              <span>
                <b>{distance(8, unit)}</b>Width
              </span>
              <span>
                <b>{distance(c.length, unit)}</b>Length
              </span>
              <span>
                <b>{distance(productHeight(c), unit)}</b>Height
              </span>
            </div>
            <div className="included">
              <Check size={14} />
              <p>{product.features}</p>
            </div>
            {c.family === 'studio' && (
              <label className="field-label studio-layout">
                Configuration request
                <select
                  value={c.studioLayout}
                  onChange={(e) =>
                    onChange({ ...c, studioLayout: e.target.value as Config['studioLayout'] })
                  }
                >
                  {STUDIO_LAYOUTS.map((layout) => (
                    <option key={layout.id} value={layout.id}>
                      {layout.name}
                    </option>
                  ))}
                </select>
              </label>
            )}
            {c.studioLayout !== 'single' && (
              <p className="inline-notice">
                Custom inquiry recorded. The scene shows one reference unit, not the connected or
                stacked project. Unit count, arrangement, engineering, and pricing require Fury
                review.
              </p>
            )}
            <p className="muted small">
              Sources checked {PRODUCT_SOURCE_DATE}. Nominal exterior sizes; usable space and
              technical specifications require confirmation.
            </p>
            <div className="section-label inspiration-label">
              Concept inspiration, not Fury packages <ArrowDownRight size={16} />
            </div>
            <div className="inspiration-list">
              <button onClick={() => onTemplate('athlete')}>
                <span className="inspiration-icon">
                  <Dumbbell size={20} />
                </span>
                <span>
                  <strong>The daily athlete</strong>
                  <small>Strength. Focus. Repeat.</small>
                </span>
                <ArrowRight size={15} />
              </button>
              <button onClick={() => onTemplate('retreat')}>
                <span className="inspiration-icon warm">
                  <Waves size={20} />
                </span>
                <span>
                  <strong>The private retreat</strong>
                  <small>Recovery, reimagined.</small>
                </span>
                <ArrowRight size={15} />
              </button>
              <button onClick={() => onTemplate('flow')}>
                <span className="inspiration-icon pale">
                  <Wind size={20} />
                </span>
                <span>
                  <strong>The movement studio</strong>
                  <small>Space to find your flow.</small>
                </span>
                <ArrowRight size={15} />
              </button>
            </div>
          </>
        )}
        {step === 1 && (
          <>
            <div className="panel-title">
              <span className="eyebrow">AN EXPRESSION OF YOU</span>
              <h2>
                Beautiful.
                <br />
                From the outside in.
              </h2>
              <p>
                {c.family === 'studio'
                  ? 'Published Studio additions, with concept finishes.'
                  : 'Published Container openings, with concept finishes.'}
              </p>
            </div>
            {c.family === 'container' && (
              <>
                <div className="section-label">Access + openings</div>
                <div className="opening-options" role="group" aria-label="Container opening">
                  {CONTAINER_OPENINGS.map((opening) => (
                    <button
                      key={opening.id}
                      aria-pressed={c.containerOpening === opening.id}
                      className={`opening-card ${c.containerOpening === opening.id ? 'selected' : ''}`}
                      onClick={() => {
                        const next = { ...c, containerOpening: opening.id }
                        if (layoutIssues(next).length) {
                          notify('Rearrange equipment to keep the selected opening’s entry clear.')
                          return
                        }
                        onChange(next)
                      }}
                    >
                      <strong>{opening.name}</strong>
                      <small>{opening.detail}</small>
                      <span>Quote required</span>
                    </button>
                  ))}
                </div>
                <p className="muted small">
                  Available on 20′ and 40′ builds. Roll-up shown open. Open-side widths, positions,
                  door height, and structure are conceptual, not approved construction dimensions.
                </p>
                <Toggle
                  label="Integrated exterior finish"
                  detail="Published design option. Material, detailing, and cost require a quote."
                  checked={c.integratedFinish}
                  onChange={() => onChange({ ...c, integratedFinish: !c.integratedFinish })}
                />
              </>
            )}
            <div className="section-label">
              Concept color study <span>{FINISHES.find((f) => f.id === c.finish)!.name}</span>
            </div>
            <p className="muted small">
              Visualization palette only—not Fury’s approved finish names or availability.
            </p>
            <div className="finish-options">
              {FINISHES.map((f) => (
                <button
                  key={f.id}
                  className={c.finish === f.id ? 'selected' : ''}
                  aria-pressed={c.finish === f.id}
                  onClick={() => onChange({ ...c, finish: f.id })}
                >
                  <span className="finish-swatch" style={{ background: f.color }}>
                    {c.finish === f.id && (
                      <Check size={18} color={f.id === 'chalk' ? '#252d23' : '#fff'} />
                    )}
                  </span>
                  <strong>{f.name}</strong>
                  <small>Concept</small>
                </button>
              ))}
            </div>
            {c.family === 'studio' && (
              <>
                <Toggle
                  label="Concept timber accent"
                  detail="Visual study only. Material and availability unconfirmed."
                  checked={c.accent}
                  onChange={() => onChange({ ...c, accent: !c.accent })}
                />
                <div className="section-label separated">
                  Published Studio additions <span>Quote required</span>
                </div>
                <div className="addon-list">
                  {ADDONS.map((addon, i) => {
                    const icons = [Layers3, TreePine, Sun, Footprints],
                      Icon = icons[i]
                    return (
                      <button
                        key={addon.id}
                        className={`addon ${c.addons[addon.id] ? 'selected' : ''}`}
                        aria-pressed={c.addons[addon.id]}
                        onClick={() => {
                          const result = setAddon(c, addon.id)
                          onChange(result.config)
                          if (result.notice) notify(result.notice)
                        }}
                      >
                        <span className="addon-icon">
                          <Icon size={21} strokeWidth={1.3} />
                        </span>
                        <span className="addon-description">
                          <strong>{addon.name}</strong>
                          <small>{addon.detail}</small>
                          <b>Quote required</b>
                        </span>
                        <span className="check-square">
                          {c.addons[addon.id] ? <Check size={13} /> : <Plus size={13} />}
                        </span>
                      </button>
                    )
                  })}
                </div>
                <p className="muted small">
                  Available individually or combined. All add-on geometry is conceptual; support,
                  access, and compatibility need Fury’s approval.
                </p>
                {c.addons.roof && !c.addons.stairs && (
                  <p className="inline-notice">
                    Rooftop selected without stairs. An approved access solution is required before
                    installation.
                  </p>
                )}
              </>
            )}
          </>
        )}
        {step === 2 && (
          <>
            <div className="panel-title">
              <span className="eyebrow">BUILT AROUND YOUR RITUAL</span>
              <h2>
                Your best self.
                <br />
                Right at home.
              </h2>
              <p>Concept planning layouts—not Fury equipment packages.</p>
            </div>
            <div className="package-options">
              {PACKAGES.map((p) => {
                const Icon = packageIcons[p.icon]
                return (
                  <button
                    key={p.id}
                    className={c.package === p.id ? 'selected' : ''}
                    aria-pressed={c.package === p.id}
                    onClick={() => applyPackage(p.id)}
                  >
                    <Icon size={21} strokeWidth={1.4} />
                    <strong>{p.name}</strong>
                    <small>{p.subtitle}</small>
                    {c.package === p.id && <Check className="package-check" size={13} />}
                  </button>
                )
              })}
            </div>
            <button className="plan-button" onClick={onPlan}>
              <ScanLine size={19} />
              <span>
                <strong>See how it fits</strong>
                <small>Floor plan · {configItems(c).length} items</small>
              </span>
              <ArrowRight size={17} />
            </button>
            <div className="section-label separated">Concept floor appearance</div>
            <p className="muted small">
              Fury lists performance flooring. These looks and materials are not confirmed
              purchasable options.
            </p>
            <div className="floor-options">
              {FLOORS.map((f) => (
                <button
                  key={f.id}
                  aria-pressed={c.flooring === f.id}
                  className={c.flooring === f.id ? 'selected' : ''}
                  onClick={() => onChange({ ...c, flooring: f.id })}
                >
                  <span style={{ background: f.color }} />
                  {f.name}
                  {c.flooring === f.id && <Check size={13} />}
                </button>
              ))}
            </div>
            <Toggle
              label="Concept mirror wall"
              detail="Visual study only. Availability requires confirmation."
              checked={c.mirror}
              onChange={() => onChange({ ...c, mirror: !c.mirror })}
            />
          </>
        )}
        {step === 3 && (
          <>
            <div className="panel-title">
              <span className="eyebrow">PICTURE THE EVERYDAY</span>
              <h2>
                A different
                <br />
                kind of escape.
              </h2>
              <p>Find your light. Set the scene.</p>
            </div>
            <div className="section-label">
              Surroundings <span>Concept settings</span>
            </div>
            <div className="environment-options">
              {ENVIRONMENTS.map((env, i) => {
                const icons = [TreePine, Fence, Building2, Layers3],
                  Icon = icons[i]
                return (
                  <button
                    key={env.id}
                    className={`environment-card ${env.id} ${c.environment === env.id ? 'selected' : ''}`}
                    aria-pressed={c.environment === env.id}
                    onClick={() => onChange({ ...c, environment: env.id })}
                  >
                    <Icon size={24} strokeWidth={1} />
                    <span>{env.name}</span>
                    {c.environment === env.id && <Check size={14} />}
                  </button>
                )
              })}
            </div>
            <div className="section-label separated">
              Find your light <span>{c.environment === 'studio' ? 'Studio lighting' : null}</span>
            </div>
            <LightingControl config={c} onChange={onChange} />
            {c.environment !== 'studio' && c.lighting === 'night' && (
              <Toggle
                label="Architectural lighting"
                detail="A warm welcome after dark."
                checked={c.lights}
                onChange={() => onChange({ ...c, lights: !c.lights })}
              />
            )}
            <p className="muted small">
              Lighting is artistic, not a location-based sun or shadow study.
            </p>
            <div className="section-label separated">Make yourself comfortable</div>
            <div className="setting-row">
              <span>Measurements</span>
              <div className="segmented">
                {(['ft', 'm'] as const).map((u) => (
                  <button
                    key={u}
                    className={unit === u ? 'active' : ''}
                    aria-pressed={unit === u}
                    onClick={() => setUnit(u)}
                  >
                    {u === 'ft' ? 'Imperial' : 'Metric'}
                  </button>
                ))}
              </div>
            </div>
            <div className="setting-row">
              <span>Render quality</span>
              <div className="segmented">
                {(['ultra', 'high', 'lite'] as const).map((q) => (
                  <button
                    key={q}
                    className={quality === q ? 'active' : ''}
                    aria-pressed={quality === q}
                    onClick={() => setQuality(q)}
                  >
                    {q === 'ultra' ? 'Ultra' : q === 'high' ? 'High' : 'Lite'}
                  </button>
                ))}
              </div>
            </div>
            <p className="muted small quality-detail">{QUALITY_DETAILS[quality]}</p>
            <div className="nature-note">
              <Leaf size={22} />
              <p>
                Less commute.
                <br />
                <strong>More you.</strong>
              </p>
            </div>
            <details className="catalog-details">
              <summary>
                What this concept includes <ChevronDown size={16} />
              </summary>
              <p className="muted small">
                All models are procedural interpretations, not manufacturer CAD. Structural
                suitability, roof occupancy, stair design, equipment clearances, accessibility,
                permits, HVAC, and site services require professional review. No AR, zoning checks,
                or engineering certification is implied.
              </p>
            </details>
          </>
        )}
      </div>
      <div className="panel-next">
        <span>
          <Flame size={13} /> MAKE ROOM FOR MORE.
        </span>
        <button onClick={() => setStep((step + 1) % 4)}>
          {step === 3 ? 'Back to space' : STEPS[step + 1]}
          <ArrowRight size={16} />
        </button>
      </div>
    </aside>
  )
}

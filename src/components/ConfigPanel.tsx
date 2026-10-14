import {
  ArrowDownRight,
  ArrowRight,
  Check,
  ChevronDown,
  Dumbbell,
  Flame,
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
  CATALOG,
  FINISHES,
  FLOORS,
  PACKAGES,
  addEquipment,
  area,
  distance,
  layoutIssues,
  money,
  packageItems,
  setAddon,
  type Config,
  type PackageId,
  type Unit,
} from '../lib/config'

const STEPS = ['Studio', 'Exterior', 'Interior', 'Setting']
export function MiniStudio({
  finish = '#353c33',
  long = false,
  deck = false,
}: {
  finish?: string
  long?: boolean
  deck?: boolean
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
      <path d="M 35 31 L 136 39 L 136 58 L 35 50 Z" fill="#afbfac" opacity=".65" />
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
  quality: 'high' | 'lite'
  setQuality: (q: 'high' | 'lite') => void
  notify: (message: string) => void
  onPlan: () => void
  onTemplate: (id: 'athlete' | 'retreat' | 'flow') => void
}) {
  const applyPackage = (id: PackageId) => {
    if (
      c.items.length > 0 &&
      !window.confirm(
        'Replace the current equipment layout with this package? Your previous layout will remain available through Undo.',
      )
    )
      return
    onChange({ ...c, package: id, items: packageItems(id, c.length) })
    notify(
      `${PACKAGES.find((p) => p.id === id)!.name} layout applied. You can customize every item.`,
    )
  }
  return (
    <aside className="config-panel" aria-label="Studio configuration">
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
              <span className="eyebrow">START WITH YOUR SPACE</span>
              <h2>
                A little room.
                <br />A lot of possibility.
              </h2>
              <p>
                Purpose-built for your practice.
                <br />
                Designed to feel entirely yours.
              </p>
            </div>
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
                        'Your equipment needs more room. Rearrange or remove items in the floor plan before choosing S-20.',
                      )
                      return
                    }
                    onChange(updated)
                  }}
                >
                  <div className="size-card-top">
                    <span>S-{length}</span>
                    <span className="selection-dot">
                      {c.length === length && <Check size={11} />}
                    </span>
                  </div>
                  <MiniStudio long={length === 40} />
                  <div className="size-card-bottom">
                    <strong>{distance(length, unit)} studio</strong>
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
                <b>{distance(10, unit)}</b>Height
              </span>
            </div>
            <div className="included">
              <Check size={14} />
              <p>
                Concept shell includes insulation, electrical, lighting, and performance flooring.
              </p>
            </div>
            <div className="section-label inspiration-label">
              A starting point, not a limit <ArrowDownRight size={16} />
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
              <p>Considered finishes. Open-air possibilities.</p>
            </div>
            <div className="section-label">
              Powder-coat finish <span>{FINISHES.find((f) => f.id === c.finish)!.name}</span>
            </div>
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
                  <small>{f.price ? `+${money((f.price * c.length) / 20)}` : 'Included'}</small>
                </button>
              ))}
            </div>
            <Toggle
              label="Cedar accent cladding"
              detail={`Natural warmth. Slatted texture. +${money((3800 * c.length) / 20)}`}
              checked={c.accent}
              onChange={() => onChange({ ...c, accent: !c.accent })}
            />
            <div className="section-label separated">
              Expand your horizons <span>4 additions</span>
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
                      <b>+{money(addon.price * (addon.id === 'stairs' ? 1 : c.length / 20))}</b>
                    </span>
                    <span className="check-square">
                      {c.addons[addon.id] ? <Check size={13} /> : <Plus size={13} />}
                    </span>
                  </button>
                )
              })}
            </div>
            {c.addons.roof && !c.addons.stairs && (
              <p className="inline-notice">
                Rooftop selected without stairs. An approved access solution is required before
                installation.
              </p>
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
              <p>Start with a curated layout. Make it your own.</p>
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
                <strong>Make it fit your life</strong>
                <small>Edit your floor plan · {c.items.length} items</small>
              </span>
              <ArrowRight size={17} />
            </button>
            <div className="section-label separated">Underfoot</div>
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
              label="Mirror wall"
              detail={`Add depth to your practice. +${money((1400 * c.length) / 20)}`}
              checked={c.mirror}
              onChange={() => onChange({ ...c, mirror: !c.mirror })}
            />
            <details className="catalog-details">
              <summary>
                Add individual equipment <ChevronDown size={16} />
              </summary>
              <p className="muted small">
                Generic planning models, not endorsed partner products. Prices and working
                clearances are illustrative.
              </p>
              <div className="catalog">
                {CATALOG.map((p) => (
                  <button
                    key={p.id}
                    onClick={() => {
                      const next = addEquipment(c, p.id)
                      if (next) {
                        onChange(next)
                        notify(`${p.name} added. Drag it into place in the floor plan.`)
                      } else
                        notify(
                          'No collision-free position is available. Remove or rearrange equipment, or choose a larger studio.',
                        )
                    }}
                  >
                    <span>
                      <strong>{p.name}</strong>
                      <small>
                        {distance(p.w, unit)} × {distance(p.d, unit)} · {money(p.price)}
                      </small>
                    </span>
                    <Plus size={16} />
                  </button>
                ))}
              </div>
            </details>
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
              {(['courtyard', 'desert', 'studio'] as const).map((env, i) => {
                const icons = [TreePine, Sun, Layers3],
                  Icon = icons[i]
                return (
                  <button
                    key={env}
                    className={`environment-card ${env} ${c.environment === env ? 'selected' : ''}`}
                    aria-pressed={c.environment === env}
                    onClick={() => onChange({ ...c, environment: env })}
                  >
                    <Icon size={24} strokeWidth={1} />
                    <span>
                      {env === 'courtyard'
                        ? 'The courtyard'
                        : env === 'desert'
                          ? 'Desert retreat'
                          : 'Studio backdrop'}
                    </span>
                    {c.environment === env && <Check size={14} />}
                  </button>
                )
              })}
            </div>
            <div className="section-label separated">
              Chase the light{' '}
              <span>
                {Math.floor(c.time)}:{c.time % 1 ? '30' : '00'}
              </span>
            </div>
            <input
              className="time-slider"
              type="range"
              min="6"
              max="21"
              step="0.5"
              value={c.time}
              aria-label="Time of day"
              onChange={(e) => onChange({ ...c, time: Number(e.target.value) })}
            />
            <div className="time-labels">
              <span>
                <Sun size={13} /> Morning
              </span>
              <span>
                <Moon size={13} /> After dark
              </span>
            </div>
            <Toggle
              label="Architectural lighting"
              detail="A warm welcome, any time of day."
              checked={c.lights}
              onChange={() => onChange({ ...c, lights: !c.lights })}
            />
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
                {(['high', 'lite'] as const).map((q) => (
                  <button
                    key={q}
                    className={quality === q ? 'active' : ''}
                    aria-pressed={quality === q}
                    onClick={() => setQuality(q)}
                  >
                    {q === 'high' ? 'High' : 'Lite'}
                  </button>
                ))}
              </div>
            </div>
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
          {step === 3 ? 'Back to studio' : STEPS[step + 1]}
          <ArrowRight size={16} />
        </button>
      </div>
    </aside>
  )
}

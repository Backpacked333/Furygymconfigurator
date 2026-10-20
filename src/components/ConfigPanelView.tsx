import type { ReactNode } from 'react'
import {
  ArrowRight,
  Building2,
  Check,
  ChevronDown,
  Flame,
  Footprints,
  Home,
  Layers3,
  Leaf,
  Plus,
  ScanLine,
  Sun,
  Sunrise,
  TreePine,
  Umbrella,
} from 'lucide-react'
import {
  ADDONS,
  FINISHES,
  FLOORS,
  INTERIORS,
  RAILINGS,
  addonAvailable,
  area,
  distance,
  money,
  productHeight,
  type AddonId,
  type Config,
  type Unit,
} from '../lib/config'
import {
  PRODUCT_FAMILIES,
  CONTAINER_OPENINGS,
  OPENING_INFILLS,
  PORTFOLIO_NOTE,
  STUDIO_DOORS,
  PRODUCT_SOURCE_DATE,
  productFamily,
} from '../lib/products'
import { Elevation } from './Elevation'

const STEPS = ['Space', 'Exterior', 'Interior', 'Setting']
type Field =
  | 'family'
  | 'length'
  | 'containerOpening'
  | 'openingInfill'
  | 'integratedFinish'
  | 'studioDoor'
  | 'doorsOpen'
  | 'finish'
  | 'accent'
  | 'railing'
  | 'interiorStyle'
  | 'flooring'
  | 'mirror'

/** A single user intent, never an editable Config or an equipment mutation. */
export type ConfigPanelChange =
  { [K in Field]: { field: K; value: Config[K] } }[Field] | { field: 'addon'; value: AddonId }

/** UI-owned interest identifiers. Only the legacy adapter connects these to prefetch. */
export type ConfigPanelInterestField =
  | 'containerOpening'
  | 'openingInfill'
  | 'studioDoor'
  | 'finish'
  | 'interiorStyle'
  | 'flooring'
  | 'environment'
type InterestHandlers = { onPointerEnter: () => void; onFocus: () => void }
export type ConfigPanelInteractions = {
  section: (field: ConfigPanelInterestField) => InterestHandlers
  option: (field: ConfigPanelInterestField, value: string) => InterestHandlers
  rendering: (field: ConfigPanelInterestField, value: string) => string
}
export type ConfigPanelSceneChoice = {
  id: string
  name: string
  environment: Config['environment']
  onChoose: () => void
}
export type ConfigPanelViewProps = {
  /** One-way display projection. This presenter never spreads it into a mutation callback. */
  config: Config
  onFieldChange: (change: ConfigPanelChange) => void
  step: number
  setStep: (step: number) => void
  unit: Unit
  setUnit: (unit: Unit) => void
  id?: string
  tabIdPrefix?: string
  panelId?: string
  interactions?: ConfigPanelInteractions
  showFamilyStartingPrices?: boolean
  signatures?: ReactNode
  inquiry?: ReactNode
  equipment: ReactNode
  equipmentCatalog?: ReactNode
  interiorDescription?: ReactNode
  plan: { onOpen: () => void; title: string; detail: string }
  sceneChoices: readonly ConfigPanelSceneChoice[]
  selectedScene: string
  sceneLabel?: string
  sceneDetail?: string
  sceneControls?: ReactNode
  renderSettings?: ReactNode
  notices?: ReactNode
  unavailableDoorNotice?: ReactNode
  fixedDoorNotice?: ReactNode
  conceptDescription?: ReactNode
}

export function ConfigPanelToggle({
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
const addonIcons = {
  deck: Layers3,
  gazebo: TreePine,
  roof: Sun,
  stairs: Footprints,
  canopy: Umbrella,
}
const environmentIcons = {
  residences: Building2,
  campus: Sunrise,
  backyard: Home,
  courtyard: TreePine,
  desert: Sun,
  studio: Layers3,
}
const interiorSwatch: Record<Config['interiorStyle'], string> = {
  gallery: 'linear-gradient(180deg, #f5f3ef 0 72%, #ffe9c8 72% 76%, #f1efea 76%)',
  slatted:
    'repeating-linear-gradient(90deg, #c49a6a 0 5px, #1b1c1b 5px 8px) top / 100% 30% no-repeat, #efebe4',
  timber: 'repeating-linear-gradient(180deg, #c98c57 0 7px, #9f6a3d 7px 8px)',
  birch: 'linear-gradient(90deg, #dcc199 0 49%, #8a7356 49% 51%, #d8bc93 51%)',
}

/** The existing Fury panel presentation, shared by the legacy and image-first adapters. */
export function ConfigPanelView({
  config: c,
  onFieldChange,
  step,
  setStep,
  unit,
  setUnit,
  id,
  tabIdPrefix = 'step-',
  panelId = 'step-content',
  interactions,
  showFamilyStartingPrices = true,
  signatures,
  inquiry,
  equipment,
  equipmentCatalog,
  interiorDescription = 'Concept planning layouts—not Fury equipment packages.',
  plan,
  sceneChoices,
  selectedScene,
  sceneLabel = 'Surroundings',
  sceneDetail = 'Concept settings',
  sceneControls,
  renderSettings,
  notices,
  unavailableDoorNotice,
  fixedDoorNotice,
  conceptDescription = 'All models are procedural interpretations, not manufacturer CAD. Structural suitability, roof occupancy, stair design, equipment clearances, accessibility, permits, HVAC, and site services require professional review. No AR, zoning checks, or engineering certification is implied.',
}: ConfigPanelViewProps) {
  const product = productFamily(c.family)
  const container = c.family === 'container'
  const rendering = (field: ConfigPanelInterestField, value: string) =>
    interactions?.rendering(field, value) ?? ''
  const operable = container ? c.containerOpening === 'roll-up' || c.openingInfill !== 'none' : true
  const operableLabel = !container
    ? 'Show the door open'
    : c.containerOpening === 'roll-up'
      ? 'Show the roll-up door raised'
      : c.openingInfill === 'awning'
        ? 'Show the sashes propped open'
        : 'Show the glass door raised'
  return (
    <aside
      className="config-panel"
      aria-label="Gym configuration"
      id={id}
      tabIndex={id ? -1 : undefined}
    >
      <div className="panel-tabs" role="tablist" aria-label="Configuration steps">
        {STEPS.map((label, i) => (
          <button
            key={label}
            role="tab"
            id={`${tabIdPrefix}${i}`}
            aria-selected={step === i}
            aria-controls={panelId}
            tabIndex={step === i ? 0 : -1}
            onClick={() => setStep(i)}
            onKeyDown={(e) => {
              if (!['ArrowRight', 'ArrowLeft', 'Home', 'End'].includes(e.key)) return
              e.preventDefault()
              const next =
                e.key === 'Home'
                  ? 0
                  : e.key === 'End'
                    ? 3
                    : (step + (e.key === 'ArrowRight' ? 1 : 3)) % 4
              setStep(next)
              document.getElementById(`${tabIdPrefix}${next}`)?.focus()
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
        id={panelId}
        aria-labelledby={`${tabIdPrefix}${step}`}
        tabIndex={0}
        key={step}
      >
        {notices}
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
            {signatures}
            <div className="section-label">Choose your product family</div>
            <div className="family-options" role="group" aria-label="Product family">
              {PRODUCT_FAMILIES.map((family) => (
                <button
                  key={family.id}
                  className={`family-card ${c.family === family.id ? 'selected' : ''}`}
                  aria-pressed={c.family === family.id}
                  aria-label={family.name}
                  onClick={() => onFieldChange({ field: 'family', value: family.id })}
                >
                  <strong>{family.name}</strong>
                  <small>{family.description}</small>
                  <span>
                    {showFamilyStartingPrices
                      ? `Family from ${money(family.startingPrice)}`
                      : 'Quote required'}
                  </span>
                </button>
              ))}
            </div>
            <p className="muted small">
              {showFamilyStartingPrices
                ? 'Published family starting prices—not a price for this size or configuration. All selections require a quote.'
                : 'All selections require a quote. These draft arrangements are not approved build specifications.'}
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
                  aria-label={`${length} ft ${product.shortName}`}
                  onClick={() => onFieldChange({ field: 'length', value: length })}
                >
                  <div className="size-card-top">
                    <span>
                      {length}′ {product.shortName}
                    </span>
                    <span className="selection-dot">
                      {c.length === length && <Check size={11} />}
                    </span>
                  </div>
                  <Elevation
                    config={{ ...c, length, items: c.length === length ? c.items : [] }}
                    className="mini-studio"
                  />
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
            {inquiry}
            <p className="muted small">
              Sources checked {PRODUCT_SOURCE_DATE}. Nominal exterior sizes; usable space and
              technical specifications require confirmation.
            </p>
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
                {container
                  ? 'Published Container openings and portfolio glazing, with concept finishes.'
                  : 'Published Studio additions and portfolio doors, with concept finishes.'}
              </p>
            </div>
            {container ? (
              <>
                <div className="section-label">Access + openings</div>
                <div
                  className="opening-options"
                  role="group"
                  aria-label="Container opening"
                  {...interactions?.section('containerOpening')}
                >
                  {CONTAINER_OPENINGS.map((opening) => (
                    <button
                      key={opening.id}
                      {...interactions?.option('containerOpening', opening.id)}
                      aria-pressed={c.containerOpening === opening.id}
                      className={`opening-card ${c.containerOpening === opening.id ? 'selected' : ''}`}
                      onClick={() =>
                        onFieldChange({ field: 'containerOpening', value: opening.id })
                      }
                    >
                      <strong>{opening.name}</strong>
                      <small>{opening.detail}</small>
                      <span>Quote required</span>
                    </button>
                  ))}
                </div>
                <p className="muted small">
                  Available on 20′ and 40′ builds. Open-side widths, positions, door height, and
                  structure are conceptual, not approved construction dimensions.
                </p>
                {c.containerOpening !== 'roll-up' && (
                  <>
                    <div className="section-label">
                      Fill the opening <span>Portfolio</span>
                    </div>
                    <div
                      className="choice-list"
                      role="group"
                      aria-label="Opening infill"
                      {...interactions?.section('openingInfill')}
                    >
                      {OPENING_INFILLS.map((infill) => (
                        <button
                          key={infill.id}
                          {...interactions?.option('openingInfill', infill.id)}
                          aria-pressed={c.openingInfill === infill.id}
                          className={`choice-card ${c.openingInfill === infill.id ? 'selected' : ''}`}
                          onClick={() =>
                            onFieldChange({ field: 'openingInfill', value: infill.id })
                          }
                        >
                          <span>
                            <strong>{infill.name}</strong>
                            <small>{infill.detail}</small>
                          </span>
                          <span className="check-square">
                            {c.openingInfill === infill.id && <Check size={13} />}
                          </span>
                        </button>
                      ))}
                    </div>
                    <p className="muted small">{PORTFOLIO_NOTE}</p>
                  </>
                )}
                <ConfigPanelToggle
                  label="Integrated exterior finish"
                  detail="Published design option. Material, detailing, and cost require a quote."
                  checked={c.integratedFinish}
                  onChange={() =>
                    onFieldChange({ field: 'integratedFinish', value: !c.integratedFinish })
                  }
                />
              </>
            ) : (
              <>
                <div className="section-label">
                  Glazed front <span>Portfolio</span>
                </div>
                <div
                  className="choice-list"
                  role="group"
                  aria-label="Studio door"
                  {...interactions?.section('studioDoor')}
                >
                  {STUDIO_DOORS.map((door) => (
                    <button
                      key={door.id}
                      {...interactions?.option('studioDoor', door.id)}
                      aria-pressed={c.studioDoor === door.id}
                      className={`choice-card ${c.studioDoor === door.id ? 'selected' : ''}`}
                      onClick={() => onFieldChange({ field: 'studioDoor', value: door.id })}
                    >
                      <span>
                        <strong>{door.name}</strong>
                        <small>{door.detail}</small>
                      </span>
                      <span className="check-square">
                        {c.studioDoor === door.id && <Check size={13} />}
                      </span>
                    </button>
                  ))}
                </div>
              </>
            )}
            {fixedDoorNotice ??
              (operable ? (
                <ConfigPanelToggle
                  label={operableLabel}
                  detail="Visualization only. Shows how the door or glazing operates."
                  checked={c.doorsOpen}
                  onChange={() => onFieldChange({ field: 'doorsOpen', value: !c.doorsOpen })}
                />
              ) : (
                unavailableDoorNotice
              ))}
            <div className="section-label">
              Concept color study <span>{FINISHES.find((f) => f.id === c.finish)!.name}</span>
            </div>
            <p className="muted small">
              Visualization palette only—not Fury’s approved finish names or availability.
            </p>
            <div
              className="finish-options"
              role="group"
              aria-label="Exterior finish"
              {...interactions?.section('finish')}
            >
              {FINISHES.map((f) => (
                <button
                  key={f.id}
                  {...interactions?.option('finish', f.id)}
                  className={c.finish === f.id ? 'selected' : ''}
                  aria-pressed={c.finish === f.id}
                  aria-label={f.name}
                  onClick={() => onFieldChange({ field: 'finish', value: f.id })}
                >
                  <span
                    className={`finish-swatch${rendering('finish', f.id)}`}
                    style={{ background: f.color }}
                  >
                    {c.finish === f.id && (
                      <Check
                        size={18}
                        color={f.id === 'chalk' || f.id === 'cloud' ? '#252d23' : '#fff'}
                      />
                    )}
                  </span>
                  <strong>{f.name}</strong>
                  <small>Concept</small>
                </button>
              ))}
            </div>
            {!container && (
              <ConfigPanelToggle
                label="Concept timber accent"
                detail="Visual study only. Material and availability unconfirmed."
                checked={c.accent}
                onChange={() => onFieldChange({ field: 'accent', value: !c.accent })}
              />
            )}
            <div className="section-label separated">
              {container ? 'Portfolio additions' : 'Published Studio additions'}{' '}
              <span>Quote required</span>
            </div>
            <div className="addon-list">
              {ADDONS.filter((addon) => addonAvailable(c.family, addon.id)).map((addon) => {
                const Icon = addonIcons[addon.id]
                return (
                  <button
                    key={addon.id}
                    className={`addon ${c.addons[addon.id] ? 'selected' : ''}`}
                    aria-pressed={c.addons[addon.id]}
                    onClick={() => onFieldChange({ field: 'addon', value: addon.id })}
                  >
                    <span className="addon-icon">
                      <Icon size={21} strokeWidth={1.3} />
                    </span>
                    <span className="addon-description">
                      <strong>{addon.name}</strong>
                      <small>{container ? addon.containerDetail : addon.detail}</small>
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
            {(c.addons.roof || c.addons.stairs) && (
              <div className="setting-row railing-row">
                <span>Guard rail</span>
                <div className="segmented" role="group" aria-label="Guard rail">
                  {RAILINGS.map((r) => (
                    <button
                      key={r.id}
                      className={c.railing === r.id ? 'active' : ''}
                      aria-pressed={c.railing === r.id}
                      onClick={() => onFieldChange({ field: 'railing', value: r.id })}
                    >
                      {r.name}
                    </button>
                  ))}
                </div>
              </div>
            )}
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
              <p>{interiorDescription}</p>
            </div>
            {equipment}
            <button className="plan-button" onClick={plan.onOpen}>
              <ScanLine size={19} />
              <span>
                <strong>{plan.title}</strong>
                <small>{plan.detail}</small>
              </span>
              <ArrowRight size={17} />
            </button>
            <div className="section-label separated">
              Interior finish <span>Concept</span>
            </div>
            <div
              className="interior-options"
              role="group"
              aria-label="Interior finish"
              {...interactions?.section('interiorStyle')}
            >
              {INTERIORS.map((style) => (
                <button
                  key={style.id}
                  {...interactions?.option('interiorStyle', style.id)}
                  aria-pressed={c.interiorStyle === style.id}
                  className={c.interiorStyle === style.id ? 'selected' : ''}
                  onClick={() => onFieldChange({ field: 'interiorStyle', value: style.id })}
                >
                  <span
                    className={`interior-swatch${rendering('interiorStyle', style.id)}`}
                    style={{ background: interiorSwatch[style.id] }}
                  />
                  <strong>{style.name}</strong>
                  <small>{style.detail}</small>
                </button>
              ))}
            </div>
            <div className="section-label separated">Concept floor appearance</div>
            <p className="muted small">
              Fury lists performance flooring. These looks and materials are not confirmed
              purchasable options.
            </p>
            <div
              className="floor-options"
              role="group"
              aria-label="Floor appearance"
              {...interactions?.section('flooring')}
            >
              {FLOORS.map((f) => (
                <button
                  key={f.id}
                  {...interactions?.option('flooring', f.id)}
                  aria-pressed={c.flooring === f.id}
                  className={c.flooring === f.id ? 'selected' : ''}
                  onClick={() => onFieldChange({ field: 'flooring', value: f.id })}
                >
                  <span
                    className={rendering('flooring', f.id).trim() || undefined}
                    style={{ background: f.color }}
                  />
                  {f.name}
                  {c.flooring === f.id && <Check size={13} />}
                </button>
              ))}
            </div>
            <ConfigPanelToggle
              label="Concept mirror wall"
              detail="Visual study only. Availability requires confirmation."
              checked={c.mirror}
              onChange={() => onFieldChange({ field: 'mirror', value: !c.mirror })}
            />
            {equipmentCatalog}
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
              {sceneLabel} <span>{sceneDetail}</span>
            </div>
            <div
              className="environment-options"
              role="group"
              aria-label={sceneLabel}
              {...interactions?.section('environment')}
            >
              {sceneChoices.map((choice) => {
                const Icon = environmentIcons[choice.environment]
                return (
                  <button
                    key={choice.id}
                    {...interactions?.option('environment', choice.id)}
                    className={`environment-card ${choice.environment} ${selectedScene === choice.id ? 'selected' : ''}${rendering('environment', choice.id)}`}
                    aria-pressed={selectedScene === choice.id}
                    onClick={choice.onChoose}
                  >
                    <Icon size={22} strokeWidth={1} />
                    <span>{choice.name}</span>
                    {selectedScene === choice.id && <Check size={14} />}
                  </button>
                )
              })}
            </div>
            {sceneControls}
            <div className="section-label separated">Make yourself comfortable</div>
            <div className="setting-row">
              <span>Measurements</span>
              <div className="segmented" role="group" aria-label="Measurements">
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
            {renderSettings}
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
              <p className="muted small">{conceptDescription}</p>
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

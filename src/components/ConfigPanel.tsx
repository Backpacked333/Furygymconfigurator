import { useEffect } from 'react'
import {
  ArrowRight,
  Check,
  ChevronDown,
  Dumbbell,
  Heart,
  Plus,
  ScanLine,
  Waves,
  Wind,
} from 'lucide-react'
import {
  CATALOG,
  ENVIRONMENTS,
  PACKAGES,
  SIGNATURES,
  addEquipment,
  distance,
  layoutIssues,
  packageItems,
  setAddon,
  setFamily,
  type Config,
  type PackageId,
  type SignatureId,
  type Unit,
} from '../lib/config'
import { QUALITY_DETAILS, type Quality } from '../render/quality'
import { usePendingChoice } from '../render/stillStatus'
import { boostOption, focusSection, showSections, type PrefetchField } from '../render/prefetch'
import { STUDIO_LAYOUTS, productFamily } from '../lib/products'
import { Elevation } from './Elevation'
import { DayNightSetting } from './DayNightSetting'
import { SCENE_LANDSCAPES } from '../domain/presentation'
import { ConfigPanelView, ConfigPanelToggle, type ConfigPanelChange } from './ConfigPanelView'

/** Renderer interest remains exclusively in this legacy adapter. */
function stepSections(step: number, c: Config): PrefetchField[] {
  if (step === 1)
    return c.family === 'studio'
      ? ['studioDoor', 'finish']
      : [
          'containerOpening',
          ...(c.containerOpening === 'roll-up' ? [] : ['openingInfill' as const]),
          'finish',
        ]
  if (step === 2) return ['interiorStyle', 'flooring']
  if (step === 3) return ['environment']
  return []
}
const section = (field: PrefetchField) => ({
  onPointerEnter: () => focusSection(field),
  onFocus: () => focusSection(field),
})
const option = (field: PrefetchField, value: string) => ({
  onPointerEnter: () => boostOption(field, value),
  onFocus: () => boostOption(field, value),
})
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
  trace,
  setTrace,
  traceSupported,
  cloud,
  notify,
  onPlan,
  onSignature,
}: {
  config: Config
  onChange: (c: Config) => void
  step: number
  setStep: (step: number) => void
  unit: Unit
  setUnit: (u: Unit) => void
  quality: Quality
  setQuality: (q: Quality) => void
  trace: boolean
  setTrace: (trace: boolean) => void
  /** Path tracing on this device needs WebGPU compute. */
  traceSupported: boolean
  /** A cloud renderer is configured: it path traces resting views for any device. */
  cloud: boolean
  notify: (message: string) => void
  onPlan: () => void
  onSignature: (id: SignatureId) => void
}) {
  const pending = usePendingChoice()
  const rendering = (field: string, value: string) =>
    pending?.field === field && pending.value === value ? ' swatch-rendering' : ''
  const sections = stepSections(step, c).join()
  useEffect(
    () => showSections(sections ? (sections.split(',') as PrefetchField[]) : []),
    [sections],
  )
  const guarded = (next: Config, message: string) => {
    if (layoutIssues(next).length) {
      notify(message)
      return
    }
    onChange(next)
  }
  const applyPackage = (id: PackageId) => {
    const next = { ...c, package: id, items: packageItems(id, c.length) }
    if (layoutIssues(next).length) {
      notify(
        'This concept layout does not keep the selected entry clear. Choose another layout or arrange equipment individually.',
      )
      return
    }
    if (
      c.items.length > 0 &&
      !window.confirm(
        'Replace the current equipment layout with this package? Your previous layout will remain available through Undo.',
      )
    )
      return
    onChange(next)
    notify(
      `${PACKAGES.find((p) => p.id === id)!.name} layout applied. You can customize every item.`,
    )
  }
  const onFieldChange = (change: ConfigPanelChange) => {
    switch (change.field) {
      case 'family': {
        const next = setFamily(c, change.value)
        if (layoutIssues(next).length) {
          notify('Rearrange equipment to keep the new entry clear before changing family.')
          return
        }
        onChange(next)
        if (c.family !== change.value)
          notify(
            `${productFamily(change.value).name} selected. Family-specific openings, doors, and additions are reset. Undo restores the previous design.`,
          )
        return
      }
      case 'length':
        guarded(
          { ...c, length: change.value },
          'Your equipment needs more room. Rearrange or remove items in the floor plan before choosing 20 feet.',
        )
        return
      case 'containerOpening':
        guarded(
          {
            ...c,
            containerOpening: change.value,
            openingInfill: change.value === 'roll-up' ? 'none' : c.openingInfill,
          },
          'Rearrange equipment to keep the selected opening’s entry clear.',
        )
        return
      case 'studioDoor':
        guarded(
          { ...c, studioDoor: change.value },
          'Rearrange equipment to keep the new door’s entry clear.',
        )
        return
      case 'addon': {
        const result = setAddon(c, change.value)
        onChange(result.config)
        if (result.notice) notify(result.notice)
        return
      }
      default:
        onChange({ ...c, [change.field]: change.value })
    }
  }
  return (
    <ConfigPanelView
      config={c}
      onFieldChange={onFieldChange}
      step={step}
      setStep={setStep}
      unit={unit}
      setUnit={setUnit}
      interactions={{ section, option, rendering }}
      signatures={
        <>
          <div className="section-label">
            Start from a Fury build <span>Portfolio</span>
          </div>
          <div className="signature-list" role="group" aria-label="Signature builds">
            {SIGNATURES.map((build) => (
              <button
                key={build.id}
                className="signature-card"
                onClick={() => onSignature(build.id)}
              >
                <Elevation config={build.config} className="signature-art" />
                <span>
                  <strong>{build.name}</strong>
                  <small>{build.subtitle}</small>
                </span>
                <ArrowRight size={15} />
              </button>
            ))}
          </div>
          <p className="muted small">
            Recreated from Fury build photography as concept models. Each one stays fully editable
            and requires a quote.
          </p>
        </>
      }
      inquiry={
        <>
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
        </>
      }
      equipment={
        <div className="package-options">
          {PACKAGES.map((p) => {
            const Icon = packageIcons[p.icon]
            return (
              <button
                key={p.id}
                className={`${c.package === p.id ? 'selected' : ''}${rendering('package', p.id)}`}
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
      }
      plan={{
        onOpen: onPlan,
        title: 'Make it fit your life',
        detail: `Edit your floor plan · ${c.items.length} items`,
      }}
      equipmentCatalog={
        <details className="catalog-details">
          <summary>
            Add individual equipment <ChevronDown size={16} />
          </summary>
          <p className="muted small">
            Generic planning models, not endorsed partner products. Dimensions and working
            clearances are illustrative. Equipment pricing requires a quote.
          </p>
          {(['Strength', 'Cardio', 'Movement', 'Recovery'] as const).map((category) => (
            <div className="catalog" key={category}>
              <span className="catalog-category">{category}</span>
              {CATALOG.filter((p) => p.category === category).map((p) => (
                <button
                  key={p.id}
                  onClick={() => {
                    const next = addEquipment(c, p.id)
                    if (next) {
                      onChange(next)
                      notify(`${p.name} added. Drag it into place in the floor plan.`)
                    } else
                      notify(
                        'No collision-free position is available. Remove or rearrange equipment, or choose a larger footprint.',
                      )
                  }}
                >
                  <span>
                    <strong>{p.name}</strong>
                    <small>
                      {distance(p.w, unit)} × {distance(p.d, unit)} · Quote required
                    </small>
                  </span>
                  <Plus size={16} />
                </button>
              ))}
            </div>
          ))}
        </details>
      }
      sceneChoices={ENVIRONMENTS.filter((env) =>
        SCENE_LANDSCAPES.some(({ id }) => id === env.id),
      ).map((env) => ({
        ...env,
        environment: env.id,
        onChoose: () => onChange({ ...c, environment: env.id }),
      }))}
      selectedScene={c.environment}
      sceneControls={
        <>
          <DayNightSetting
            label="Chase the light"
            time={c.time}
            onChange={(time) => onChange({ ...c, time })}
          />
          <ConfigPanelToggle
            label="Architectural lighting"
            detail="A warm welcome, any time of day."
            checked={c.lights}
            onChange={() => onChange({ ...c, lights: !c.lights })}
          />
          <p className="muted small">
            Lighting is artistic, not a location-based sun or shadow study.
          </p>
        </>
      }
      renderSettings={
        <>
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
          <ConfigPanelToggle
            label="Path-traced stills"
            detail={
              traceSupported || cloud
                ? `The gallery shows ray-traced stills with true bounce light, soft shadows, and real reflections, traced ${cloud ? 'in the cloud' : 'on this device'}. The 360° view is always live.`
                : 'Needs a browser with WebGPU or a cloud renderer. Real-time rendering stays available.'
            }
            checked={trace && (traceSupported || cloud)}
            onChange={() => (traceSupported || cloud) && setTrace(!trace)}
          />
        </>
      }
    />
  )
}

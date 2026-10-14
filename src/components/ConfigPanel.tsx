import { useEffect, useId, useRef, useState } from 'react'
import type { EditInteractionProps } from './FloorPlan'
import type { EditToken } from '../lib/editTransactions'
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
  packageDefinition,
  setAddon,
  changeFamily,
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
  OPENING_CONCEPTS,
  featureEvidence,
  productFamily,
} from '../lib/products'

const STEPS = ['Space', 'Exterior', 'Interior', 'Setting']
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

function DaylightControl(
  props: {
    config: Config
    onChange: (config: Config) => void
    notify: (message: string) => void
  } & EditInteractionProps,
) {
  const latest = useRef(props)
  latest.current = props
  const input = useRef<HTMLInputElement>(null)
  const pointer = useRef<number | null>(null)
  const capturedInput = useRef<HTMLInputElement | null>(null)
  const keys = useRef(new Set<string>())
  const edit = useRef<{
    base: Config
    candidate: Config
    token?: EditToken
    revision?: number
    key?: string | number
  } | null>(null)
  const [previewTime, setPreviewTime] = useState<number | null>(null)
  const hint = useId()
  const blocked = () =>
    latest.current.interactionDisabled || !!document.querySelector('dialog[open]')
  const isCurrent = () => {
    const g = edit.current,
      p = latest.current
    return (
      !blocked() &&
      (!g ||
        (g.revision === p.revision &&
          g.key === p.interactionKey &&
          [JSON.stringify(g.base), JSON.stringify(g.candidate)].includes(JSON.stringify(p.config))))
    )
  }
  const release = () => {
    const id = pointer.current
    pointer.current = null
    keys.current.clear()
    if (id !== null && capturedInput.current?.hasPointerCapture?.(id))
      capturedInput.current.releasePointerCapture(id)
    capturedInput.current = null
  }
  const cancel = () => {
    const g = edit.current
    edit.current = null
    if (g?.token) latest.current.onCancelEdit?.(g.token)
    release()
    setPreviewTime(null)
  }
  const cancelRef = useRef(cancel)
  cancelRef.current = cancel
  useEffect(() => {
    if (!isCurrent()) cancelRef.current()
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
  const finish = () => {
    if (!isCurrent()) {
      cancel()
      return
    }
    const g = edit.current
    if (!g || g.base.time === g.candidate.time) {
      cancel()
      return
    }
    edit.current = null
    release()
    setPreviewTime(null)
    const result = g.token
      ? latest.current.onCommitEdit?.(g.token, g.candidate)
      : latest.current.onChange(g.candidate)
    if (result?.status === 'conflict' || result?.status === 'rejected')
      latest.current.notify(result.issues.join(' '))
  }
  const preview = (time: number) => {
    if (!isCurrent()) {
      cancel()
      return
    }
    const p = latest.current
    if (!edit.current && time === p.config.time) return
    const g = edit.current ?? {
      base: p.config,
      candidate: p.config,
      revision: p.revision,
      key: p.interactionKey,
      token:
        p.onBeginEdit && p.onPreviewEdit && p.onCommitEdit && p.onCancelEdit
          ? p.onBeginEdit()
          : undefined,
    }
    edit.current = g
    g.candidate = { ...g.base, time }
    setPreviewTime(time)
    if (g.token) {
      const result = p.onPreviewEdit?.(g.token, g.candidate)
      if (result?.status === 'conflict' || result?.status === 'rejected') {
        cancel()
        p.notify(result.issues.join(' '))
      }
    }
  }
  const time = previewTime ?? props.config.time
  const label = `${Math.floor(time)}:${Math.round((time % 1) * 60)
    .toString()
    .padStart(2, '0')}`
  return (
    <>
      <div className="section-label separated">
        Chase the light <span>{label}</span>
      </div>
      <div className="daylight-presets" role="group" aria-label="Daylight presets">
        {[
          { label: 'Morning', time: 9 },
          { label: 'Afternoon', time: 14 },
          { label: 'Golden hour', time: 17.5 },
          { label: 'Evening', time: 20 },
        ].map((preset) => (
          <button
            key={preset.time}
            disabled={props.interactionDisabled}
            aria-pressed={time === preset.time}
            onClick={() => {
              cancel()
              preview(preset.time)
              finish()
            }}
          >
            {preset.label}
          </button>
        ))}
      </div>
      <input
        ref={input}
        className="time-slider"
        type="range"
        min="6"
        max="21"
        step="0.25"
        value={time}
        disabled={props.interactionDisabled}
        aria-label="Time of day"
        aria-valuetext={label}
        aria-describedby={hint}
        onPointerDown={(e) => {
          if (
            blocked() ||
            e.button !== 0 ||
            e.isPrimary === false ||
            pointer.current !== null ||
            keys.current.size
          )
            return
          pointer.current = e.pointerId
          capturedInput.current = e.currentTarget
          e.currentTarget.setPointerCapture?.(e.pointerId)
        }}
        onPointerUp={(e) => {
          if (pointer.current === e.pointerId) finish()
        }}
        onPointerCancel={(e) => {
          if (pointer.current === e.pointerId) cancel()
        }}
        onLostPointerCapture={(e) => {
          if (pointer.current === e.pointerId) cancel()
        }}
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            e.preventDefault()
            cancel()
          } else if (
            [
              'ArrowLeft',
              'ArrowRight',
              'ArrowUp',
              'ArrowDown',
              'Home',
              'End',
              'PageUp',
              'PageDown',
            ].includes(e.key)
          ) {
            if (blocked() || pointer.current !== null || (e.repeat && !keys.current.size)) {
              e.preventDefault()
              return
            }
            keys.current.add(e.key)
          }
        }}
        onKeyUp={(e) => {
          if (keys.current.delete(e.key) && !keys.current.size) finish()
        }}
        onBlur={cancel}
        onChange={(e) => {
          preview(Number(e.target.value))
          if (pointer.current === null && !keys.current.size) finish()
        }}
      />
      <p id={hint} className="muted small daylight-hint" role="status">
        {previewTime === null
          ? 'One lighting edit per gesture. Escape cancels.'
          : 'Lighting preview — release to apply. Not part of an export.'}
      </p>
      <div className="time-labels">
        <span>
          <Sun size={13} /> Morning
        </span>
        <span>
          <Moon size={13} /> After dark
        </span>
      </div>
    </>
  )
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
  qualityMode,
  setQualityMode,
  ...editing
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
  qualityMode?: 'auto' | Quality
  setQualityMode?: (mode: 'auto' | Quality) => void
} & EditInteractionProps) {
  const [notice, setNotice] = useState('')
  const announce = (message: string) => {
    setNotice(message)
    notify(message)
  }
  const update = (next: Config) => {
    const issues = layoutIssues(next)
    if (issues.length) {
      announce(issues.join(' '))
      return
    }
    onChange(next)
  }
  const product = productFamily(c.family)
  const applyPackage = (id: PackageId) => {
    const definition = packageDefinition(id, c)
    const next = { ...c, package: id, items: definition.items }
    if (!definition.available) {
      announce(definition.issues.join(' '))
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
    announce(
      definition.notice ?? `${definition.label} layout applied. You can customize every item.`,
    )
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
        {notice && (
          <p className="inline-notice panel-notice" role="status">
            {notice}
          </p>
        )}
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
                    const result = changeFamily(c, family.id)
                    if (!result.accepted) {
                      announce(result.notice ?? result.issues.join(' '))
                      return
                    }
                    if (c.family !== family.id) {
                      onChange(result.config)
                      announce(`${family.name} selected. Existing compatible features preserved.`)
                    }
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
                  ? 'Published Studio additions, with illustrative finishes.'
                  : 'Published openings and separately labeled reference concepts.'}
              </p>
            </div>
            {c.family === 'container' && (
              <>
                <div className="section-label">Published access + openings</div>
                <div className="opening-options" role="group" aria-label="Container opening">
                  {CONTAINER_OPENINGS.map((opening) => (
                    <button
                      key={opening.id}
                      aria-pressed={
                        c.openingConcept === 'standard' && c.containerOpening === opening.id
                      }
                      className={`opening-card ${c.openingConcept === 'standard' && c.containerOpening === opening.id ? 'selected' : ''}`}
                      onClick={() => {
                        update({ ...c, openingConcept: 'standard', containerOpening: opening.id })
                      }}
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
                <div className="section-label separated">Reference-backed opening studies</div>
                <p className="muted small">
                  Visual concepts from R04, R05, R07 and R09—not published manufacturer options.
                  Mechanisms, dimensions and feasibility require review.
                </p>
                <div
                  className="opening-options concept-options"
                  role="group"
                  aria-label="Reference opening concept"
                >
                  {OPENING_CONCEPTS.filter((opening) => opening.id !== 'standard').map(
                    (opening) => (
                      <button
                        key={opening.id}
                        className={`opening-card ${c.openingConcept === opening.id ? 'selected' : ''}`}
                        aria-pressed={c.openingConcept === opening.id}
                        onClick={() => update({ ...c, openingConcept: opening.id })}
                      >
                        <strong>{opening.name}</strong>
                        <small>
                          {featureEvidence(opening.id)?.references.join(' / ')} · Reference concept
                        </small>
                      </button>
                    ),
                  )}
                </div>
                {c.openingConcept !== 'standard' && (
                  <p className="inline-notice">
                    {featureEvidence(c.openingConcept)?.wording} Select a published opening above to
                    return to sourced options.
                  </p>
                )}
                <Toggle
                  label="Integrated exterior finish"
                  detail="Published design option. Material, detailing, and cost require a quote."
                  checked={c.integratedFinish}
                  onChange={() => onChange({ ...c, integratedFinish: !c.integratedFinish })}
                />
              </>
            )}
            <div className="setting-row opening-pose">
              <span>Opening visual pose</span>
              <div className="segmented" role="group" aria-label="Opening visual pose">
                {(['closed', 'open'] as const).map((pose) => (
                  <button
                    key={pose}
                    aria-pressed={c.presentation.openingPose === pose}
                    className={c.presentation.openingPose === pose ? 'active' : ''}
                    onClick={() =>
                      update({ ...c, presentation: { ...c.presentation, openingPose: pose } })
                    }
                  >
                    {pose === 'open' ? 'Open' : 'Closed'}
                  </button>
                ))}
              </div>
            </div>
            <p className="muted small">
              Presentation pose only—not a separate product or certified door movement. Permanently
              open concepts retain their opening in either pose.
            </p>
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
              <Toggle
                label="Concept timber accent"
                detail="Visual study only. Material and availability unconfirmed."
                checked={c.accent}
                onChange={() => onChange({ ...c, accent: !c.accent })}
              />
            )}
            <div className="section-label separated">
              {c.family === 'studio'
                ? 'Published Studio additions'
                : 'Reference-backed Container additions'}{' '}
              <span>Quote required</span>
            </div>
            <div className="addon-list">
              {ADDONS.map((addon, i) => {
                if (c.family === 'container' && addon.id === 'gazebo') return null
                const icons = [Layers3, TreePine, Sun, Footprints],
                  Icon = icons[i]
                return (
                  <button
                    key={addon.id}
                    className={`addon ${c.addons[addon.id] ? 'selected' : ''}`}
                    aria-pressed={c.addons[addon.id]}
                    onClick={() => {
                      const result = setAddon(c, addon.id)
                      if (result.notice) announce(result.notice)
                      else update(result.config)
                    }}
                  >
                    <span className="addon-icon">
                      <Icon size={21} strokeWidth={1.3} />
                    </span>
                    <span className="addon-description">
                      <strong>{addon.name}</strong>
                      <small>
                        {c.family === 'studio'
                          ? addon.detail
                          : featureEvidence(`container:${addon.id}`)?.wording}
                      </small>
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
              {c.family === 'studio'
                ? 'Published addition names; '
                : 'R05 / R07 reference concepts, not published Container options; '}
              all geometry is illustrative. Support, access, roof occupancy and compatibility
              require professional review.
            </p>
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
              <p>Concept planning layouts—not Fury equipment packages.</p>
            </div>
            <div className="package-options">
              {PACKAGES.map((p) => {
                const Icon = packageIcons[p.icon]
                const definition = packageDefinition(p.id, c)
                return (
                  <button
                    key={p.id}
                    className={c.package === p.id ? 'selected' : ''}
                    aria-pressed={c.package === p.id}
                    onClick={() => applyPackage(p.id)}
                  >
                    <Icon size={21} strokeWidth={1.4} />
                    <strong>{definition.label}</strong>
                    <small>
                      {p.id === 'movement' ? 'Pilates / movement · generic reformer' : p.subtitle}
                    </small>
                    {!definition.available && <small>Layout needs adjustment</small>}
                    {c.package === p.id && <Check className="package-check" size={13} />}
                  </button>
                )
              })}
            </div>
            {c.family === 'container' && c.package === 'strength' && (
              <p className="muted small">{packageDefinition('strength', c).notice}</p>
            )}
            <button className="plan-button" onClick={onPlan}>
              <ScanLine size={19} />
              <span>
                <strong>Make it fit your life</strong>
                <small>Edit your floor plan · {c.items.length} items</small>
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
            <details className="catalog-details">
              <summary>
                Add individual equipment <ChevronDown size={16} />
              </summary>
              <p className="muted small">
                Generic planning models, not endorsed partner products. Dimensions and working
                clearances are illustrative. Equipment pricing requires a quote.
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
                          'No collision-free position is available. Remove or rearrange equipment, or choose a larger footprint.',
                        )
                    }}
                  >
                    <span>
                      <strong>{p.name}</strong>
                      <small>
                        {distance(p.w, unit)} × {distance(p.d, unit)} · Modeled occupied bounds ·
                        Quote required
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
            <div className="section-label">Project + site inquiry context</div>
            <div className="context-options" role="group" aria-label="Project and site context">
              {[
                {
                  id: 'product',
                  label: 'Product only',
                  detail: 'One reference unit; no additional site scope.',
                },
                {
                  id: 'custom-wellness',
                  label: 'Custom wellness inquiry',
                  detail: 'R08 · Architectural context, not a third standard family.',
                },
                {
                  id: 'sunken-lounge',
                  label: 'Sunken lounge site context',
                  detail: 'R09 · Site context only, not included or priced.',
                },
              ].map((context) => (
                <button
                  key={context.id}
                  className={`opening-card ${c.presentation.context === context.id ? 'selected' : ''}`}
                  aria-pressed={c.presentation.context === context.id}
                  onClick={() =>
                    onChange({
                      ...c,
                      presentation: {
                        ...c.presentation,
                        context: context.id as Config['presentation']['context'],
                      },
                    })
                  }
                >
                  <strong>{context.label}</strong>
                  <small>{context.detail}</small>
                </button>
              ))}
            </div>
            {c.presentation.context !== 'product' && (
              <p className="inline-notice">
                {featureEvidence(c.presentation.context)?.wording} Save/share retains inquiry
                intent—not a bundled or priced product.{' '}
                <a
                  href="https://www.furycogyms.com/start-a-project"
                  target="_blank"
                  rel="noreferrer"
                >
                  Discuss a custom project with Fury ↗
                </a>
              </p>
            )}
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
            <DaylightControl config={c} onChange={onChange} notify={announce} {...editing} />
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
                {setQualityMode && (
                  <button
                    aria-pressed={qualityMode === 'auto'}
                    className={qualityMode === 'auto' ? 'active' : ''}
                    onClick={() => setQualityMode('auto')}
                  >
                    Auto
                  </button>
                )}
                {(['ultra', 'high', 'lite'] as const).map((q) => (
                  <button
                    key={q}
                    className={(qualityMode ?? quality) === q ? 'active' : ''}
                    aria-pressed={(qualityMode ?? quality) === q}
                    onClick={() => (setQualityMode ? setQualityMode(q) : setQuality(q))}
                  >
                    {q === 'ultra' ? 'Ultra' : q === 'high' ? 'High' : 'Lite'}
                  </button>
                ))}
              </div>
            </div>
            <p className="muted small quality-detail">
              {qualityMode === 'auto' && `Auto · current tier: ${quality}. `}
              {QUALITY_DETAILS[quality]} Quality is not a hardware or visual certification.
            </p>
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

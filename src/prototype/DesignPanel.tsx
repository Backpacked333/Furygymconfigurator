import { useState } from 'react'
import { ChevronDown } from 'lucide-react'
import { ConfigPanelView } from '../components/ConfigPanelView'
import { arrangementFor } from '../domain/arrangements'
import {
  INQUIRY_ONLY_STUDIO_LAYOUTS,
  projectDesignToConfig,
  type DesignEnvelope,
} from '../domain/design'
import type { DesignAction } from '../domain/designTransitions'
import { SCENE_LANDSCAPES, sceneLook, sceneSelection } from '../domain/presentation'
import { catalogItem, type Unit } from '../lib/config'
import { designPanelAction } from './designPanelAdapter'
import { DayNightControl } from './SceneLookControls'

export type DesignPanelProps = {
  design: DesignEnvelope
  onAction: (action: DesignAction) => void
  unit: Unit
  setUnit: (unit: Unit) => void
  onPlan: () => void
  renderedLibrary?: boolean
} & ({ step: number; setStep: (step: number) => void } | { step?: undefined; setStep?: undefined })

/** Controlled step/setStep may be supplied together by the shell; omitted, navigation is local.
 * Only navigation has local state. Config is a one-way display projection of the v4 authority.
 */
export function DesignPanel({
  design,
  onAction,
  unit,
  setUnit,
  onPlan,
  renderedLibrary = false,
  step: controlledStep,
  setStep: setControlledStep,
}: DesignPanelProps) {
  const [localStep, setLocalStep] = useState(0)
  const { product } = design.config
  const arrangement = arrangementFor(product.family, product.lengthFt)
  const selectedScene = sceneSelection(design.presentation.lookRef)
  return (
    <ConfigPanelView
      config={projectDesignToConfig(design)}
      onFieldChange={(change) => onAction(designPanelAction(design, change))}
      step={controlledStep ?? localStep}
      setStep={setControlledStep ?? setLocalStep}
      unit={unit}
      setUnit={setUnit}
      id="prototype-configuration"
      tabIdPrefix="prototype-tab-"
      panelId="prototype-panel"
      showFamilyStartingPrices={false}
      notices={
        <p className="inline-notice">
          {renderedLibrary
            ? 'Your design, in five exact views. Existing images load instantly; request missing views when rendering is available. Draft preview · Quote and engineering review required.'
            : 'DRAFT design study. Selections do not update the historical reference or approve a current design image. Quote required; engineering, rights and art review remain open.'}
        </p>
      }
      inquiry={
        product.family === 'studio' && (
          <details className="catalog-details">
            <summary>
              Multi-unit & custom inquiries <ChevronDown size={16} />
            </summary>
            <p className="muted small">
              Single-unit concepts only. These configuration requests remain inquiry-only, not
              modeled products. No conversion or submission is available in this local prototype.
            </p>
            <ul className="muted small">
              {INQUIRY_ONLY_STUDIO_LAYOUTS.map((layout) => (
                <li key={layout.id}>{layout.name} — inquiry only</li>
              ))}
            </ul>
          </details>
        )
      }
      interiorDescription="Materials and a fixed draft equipment arrangement—not an approved equipment package."
      equipment={
        <>
          <div className="section-label">
            Fixed equipment arrangement <span>DRAFT</span>
          </div>
          <p className="muted small">
            One draft per family and size. No customer equipment placement, rotation, deletion or
            package editing. Ceiling, door and access holds remain unresolved.
          </p>
          <details className="catalog-details">
            <summary>
              Fixed inventory & review holds <ChevronDown size={16} />
            </summary>
            <p className="muted small">
              {arrangement.id} · DRAFT, not an approved build specification.
            </p>
            <ul className="muted small">
              {arrangement.items.map((item) => (
                <li key={item.id}>{catalogItem(item.sku).name}</li>
              ))}
            </ul>
            <ul className="muted small">
              {arrangement.reviewHolds.map((hold) => (
                <li key={hold}>{hold}</li>
              ))}
            </ul>
          </details>
        </>
      }
      plan={{
        onOpen: onPlan,
        title: 'View read-only plan & inventory',
        detail: `Fixed DRAFT arrangement · ${arrangement.items.length} items`,
      }}
      unavailableDoorNotice={
        <p className="muted small">Door pose unavailable: this open side has no operable door.</p>
      }
      sceneLabel="Landscape"
      sceneDetail="Four settings · Day or Night"
      sceneChoices={SCENE_LANDSCAPES.map((landscape) => ({
        id: landscape.id,
        name: landscape.name,
        environment: landscape.id,
        onChoose: () =>
          onAction({
            type: 'update-presentation',
            patch: { lookRef: sceneLook(landscape.id, selectedScene.lighting) },
          }),
      }))}
      selectedScene={selectedScene.landscape}
      sceneControls={
        <>
          <DayNightControl
            lookRef={design.presentation.lookRef}
            onChange={(lookRef) => onAction({ type: 'update-presentation', patch: { lookRef } })}
          />
          <p className="muted small">
            {renderedLibrary
              ? 'Each scene has its own five-view set. Choose Day or Night; existing views are reused, and missing views require your explicit request.'
              : 'Four landscapes with Day or Night lighting. These authored looks still require art approval; historical imagery does not follow these choices.'}
          </p>
          <div className="setting-row">
            <span>Draft composition</span>
            <div className="segmented" role="group" aria-label="Draft composition">
              {(['wide', 'tall'] as const).map((aspect) => (
                <button
                  key={aspect}
                  className={design.presentation.aspect === aspect ? 'active' : ''}
                  aria-pressed={design.presentation.aspect === aspect}
                  onClick={() => onAction({ type: 'update-presentation', patch: { aspect } })}
                >
                  {aspect === 'wide' ? 'Landscape' : 'Portrait'}
                </button>
              ))}
            </div>
          </div>
          {!renderedLibrary && (
            <div className="setting-row">
              <span>Mock output profile</span>
              <div className="segmented" role="group" aria-label="Mock output profile">
                {(['web-hero', 'web-thumbnail'] as const).map((outputProfile) => (
                  <button
                    key={outputProfile}
                    className={design.outputProfile === outputProfile ? 'active' : ''}
                    aria-pressed={design.outputProfile === outputProfile}
                    onClick={() => onAction({ type: 'set-output-profile', outputProfile })}
                  >
                    {outputProfile === 'web-hero' ? 'Hero diagnostic' : 'Thumbnail diagnostic'}
                  </button>
                ))}
              </div>
            </div>
          )}
          <p className="muted small">
            {renderedLibrary
              ? 'Native masters: 1920 × 1200 landscape or 1200 × 1500 portrait. Changing options never starts a render. Live 360° and strict reference exports are unavailable.'
              : 'Mock diagnostic only. Render quality, path tracing, live 360° and strict image/PDF exports are unavailable here.'}
          </p>
        </>
      }
      conceptDescription="All four fixed arrangements, looks, cameras and output profiles are DRAFT, not approved specifications. Ceiling, door sweeps, access, clearances, engineering, rights, art, renderer qualification and G1 gates remain open. No paid execution or production approval is implied."
    />
  )
}

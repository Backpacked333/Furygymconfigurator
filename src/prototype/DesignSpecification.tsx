import FloorPlan from '../components/FloorPlan'
import { SpecificationView } from '../components/SpecificationView'
import { arrangementEquipment, arrangementFor } from '../domain/arrangements'
import { designReviewHolds, projectDesignToConfig, type DesignEnvelope } from '../domain/design'
import { resolveCamera, resolveLook } from '../domain/presentation'
import {
  FINISHES,
  FLOORS,
  INTERIORS,
  catalogItem,
  distance,
  productHeight,
  productName,
  type Unit,
} from '../lib/config'
import { CONTAINER_OPENINGS, OPENING_INFILLS, STUDIO_DOORS } from '../lib/products'

export function DesignSpecification({
  design,
  unit,
  showPlan = false,
  compact = false,
}: {
  design: DesignEnvelope
  unit: Unit
  showPlan?: boolean
  /** Stage adapter: only the shared plan; the full specification stays available separately. */
  compact?: boolean
}) {
  const { product, structure, appearance } = design.config
  const arrangement = arrangementFor(product.family, product.lengthFt)
  // Projection is display-only. No Config mutation or equipment ingress is exposed to v4.
  const config = projectDesignToConfig(design)
  if (compact && showPlan) return <FloorPlan config={config} unit={unit} readOnly />
  return (
    <section className="prototype-spec" aria-label="Current design specification">
      <h2>Your design specification</h2>
      <p className="prototype-warning">
        DRAFT — inquiry only. Ceiling, doors and access are unresolved. Production and paid
        execution are blocked.
      </p>
      <SpecificationView
        title="Your decisions."
        columns={[{ id: 'selected', name: 'Selected design · DRAFT' }]}
        rows={[
          { label: 'Product', values: [`${productName(config)} · single unit`] },
          {
            label: 'Nominal envelope',
            values: [
              `${distance(product.lengthFt, unit)} × ${distance(8, unit)} × ${distance(productHeight(config), unit)}`,
            ],
          },
          {
            label: 'Opening',
            values: [
              structure.kind === 'studio'
                ? STUDIO_DOORS.find((door) => door.id === structure.door)!.name
                : `${CONTAINER_OPENINGS.find((opening) => opening.id === structure.opening)!.name} / ${OPENING_INFILLS.find((infill) => infill.id === structure.infill)!.name}; integrated finish ${structure.integratedFinish ? 'on' : 'off'}`,
            ],
          },
          {
            label: 'Appearance',
            values: [
              `${FINISHES.find((item) => item.id === appearance.finish)!.name} · ${INTERIORS.find((item) => item.id === appearance.interior)!.name} · ${FLOORS.find((item) => item.id === appearance.floor)!.name}`,
            ],
          },
          {
            label: 'Details',
            values: [
              `Accent ${appearance.accent ? 'on' : 'off'} · Mirror ${appearance.mirror ? 'on' : 'off'} · Door ${design.presentation.doorPose}`,
            ],
          },
          {
            label: 'Additions',
            values: [`${structure.addons.join(', ') || 'None'} · ${structure.railing} railing`],
          },
          {
            label: 'Presentation',
            values: [
              <>
                {resolveLook(design.presentation.lookRef).name}
                <br />
                {resolveCamera(design.presentation.cameraRef).name} · {design.presentation.aspect} ·{' '}
                {design.outputProfile}
              </>,
            ],
          },
          { label: 'Authority', values: [`${design.config.catalogVersion} · ${arrangement.id}`] },
          { label: 'Configured price', values: ['Quote required'] },
        ]}
        notice="Concept selections, not approved build specifications. All selections and site costs require a quote."
      />
      {showPlan && (
        <div className="prototype-plan-frame">
          <FloorPlan config={config} unit={unit} readOnly />
        </div>
      )}
      <details>
        <summary>Fixed draft inventory · {arrangement.items.length} items</summary>
        <ol className="prototype-inventory">
          {arrangement.items.map((item) => {
            const equipment = arrangementEquipment(item.sku)
            return (
              <li key={item.id}>
                {catalogItem(item.sku).name} · occupied width{' '}
                {distance(equipment.occupiedWidthFt, unit)} × depth{' '}
                {distance(equipment.depthFt, unit)} × height {distance(equipment.heightFt, unit)}
              </li>
            )
          })}
        </ol>
        <p className="muted small">
          Generic catalog dimensions before rotation, not manufacturer specifications. Rack
          footprint includes loaded bar. Clear-looking space is not approved access or exercise
          clearance.
        </p>
      </details>
      <details>
        <summary>Compatibility & approval holds</summary>
        <ul>
          {designReviewHolds(design).map((hold) => (
            <li key={hold}>{hold}</li>
          ))}
        </ul>
      </details>
    </section>
  )
}

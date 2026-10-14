import type { PlacedItem } from '../lib/config'
import { FLOOR_Y } from '../render/architecture'
import { equipmentParts } from '../render/equipment'
import { batch, type Batch } from '../render/parts'

/** Merged geometry per catalog item, shared by every placed copy for the session. */
const batches = new Map<PlacedItem['sku'], Batch[]>()
function equipmentBatches(sku: PlacedItem['sku']) {
  let merged = batches.get(sku)
  if (!merged) {
    merged = batch(equipmentParts(sku))
    batches.set(sku, merged)
  }
  return merged
}

export function Equipment({ item }: { item: PlacedItem }) {
  return (
    <group position={[item.x, FLOOR_Y, item.z]} rotation={[0, (-item.rotation * Math.PI) / 180, 0]}>
      {equipmentBatches(item.sku).map((b) => (
        <mesh
          key={b.material.uuid + b.shadow}
          geometry={b.geometry}
          material={b.material}
          castShadow={b.shadow}
          receiveShadow
          dispose={null}
        />
      ))}
      {item.sku === 'sauna' && (
        <pointLight
          position={[0, 5.2, -0.4]}
          color="#ffb072"
          intensity={6}
          distance={3.4}
          decay={2}
        />
      )}
    </group>
  )
}

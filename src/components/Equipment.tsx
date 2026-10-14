import { useState } from 'react'
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
    </group>
  )
}

/**
 * The warm glow inside each sauna. Lights live in a pool that only grows, and an empty slot stays
 * mounted but dark: adding or removing a light changes every lit material's shader, so placing or
 * removing a sauna (or picking the Recovery layout) would otherwise recompile the whole scene.
 */
export function SaunaLights({ items }: { items: PlacedItem[] }) {
  const saunas = items.filter((item) => item.sku === 'sauna')
  const [slots, setSlots] = useState(1)
  if (saunas.length > slots) setSlots(saunas.length)
  return Array.from({ length: Math.max(slots, saunas.length) }, (_, slot) => {
    const sauna = saunas[slot]
    return (
      <group
        key={slot}
        position={sauna ? [sauna.x, FLOOR_Y, sauna.z] : [0, FLOOR_Y, 0]}
        rotation={[0, sauna ? (-sauna.rotation * Math.PI) / 180 : 0, 0]}
      >
        <pointLight
          position={[0, 5.2, -0.4]}
          color="#ffb072"
          intensity={sauna ? 6 : 0}
          distance={3.4}
          decay={2}
        />
      </group>
    )
  })
}

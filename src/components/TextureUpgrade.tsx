import { useEffect } from 'react'
import { useThree } from '@react-three/fiber'
import type { Material, Mesh } from 'three/webgpu'
import { onMaterialsChanged, upgradeLiveTextures } from '../render/materials'
import { sceneProgress, whenIdle } from '@fury/viewer360'
import { useTier } from '@fury/viewer360/3d'

const idle = (callback: () => void) => whenIdle(callback, 3000)

/** Whether this device has the memory and connection for full-resolution scans. */
function canUpgrade() {
  const nav = navigator as Navigator & {
    connection?: { saveData?: boolean }
    deviceMemory?: number
  }
  return !nav.connection?.saveData && (nav.deviceMemory ?? 8) > 4
}

/**
 * In the 360 view, once the scene has drawn and the page is idle, swaps the live view's 1K
 * copies for the full 2K scans. Sets that load later (another floor, other surroundings) are
 * upgraded on a later idle moment. Only on a tier that asks for full textures (Ultra, which a
 * device reaches by proving fast); every other tier keeps the lighter maps.
 */
export function TextureUpgrade({ enabled }: { enabled: boolean }) {
  const scene = useThree((state) => state.scene)
  const full = useTier().spec.textures === 'full'
  useEffect(() => {
    if (!enabled || !full || !canUpgrade()) return
    let cancelled = false,
      running = false,
      again = false
    const pass = () => {
      if (cancelled) return
      if (running) {
        again = true
        return
      }
      running = true
      // Materials drawn right now: only these sets are worth the full download.
      const onScreen = new Set<Material>()
      scene.traverseVisible((object) => {
        const m = (object as Mesh).material
        if (Array.isArray(m)) m.forEach((x) => onScreen.add(x))
        else if (m) onScreen.add(m)
      })
      upgradeLiveTextures(
        () => cancelled,
        (m) => onScreen.has(m),
      ).finally(() => {
        running = false
        if (again && !cancelled) {
          again = false
          idle(pass)
        }
      })
    }
    const cancelStart = sceneProgress.afterNextDraw(() => idle(pass))
    // New scans arriving (a set loaded for a new choice) may be 1K copies to upgrade.
    const stop = onMaterialsChanged((change) => {
      if (change === 'textures') idle(pass)
    })
    return () => {
      cancelled = true
      cancelStart()
      stop()
    }
  }, [enabled, full, scene])
  return null
}

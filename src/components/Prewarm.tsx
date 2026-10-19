import { useEffect } from 'react'
import { useThree } from '@react-three/fiber'
import { Group, Mesh } from 'three/webgpu'
import { CATALOG, FINISHES, FLOORS, type Config } from '../lib/config'
import {
  containerInterior,
  containerShell,
  studioInterior,
  studioShell,
} from '../render/architecture'
import { deck, pergola, roofDeck, stairs, timberAccent } from '../render/addons'
import { batch, type Part } from '../render/parts'
import { sceneProgress } from '@fury/viewer360'
import { equipmentBatches } from '../render/equipment'
import { whenIdle } from '@fury/viewer360'

const idle = (callback: () => void) => whenIdle(callback, 4000)
/** Quiet time after the scene's first picture before preparing anything. */
const START_AFTER_MS = 3000

/** Devices with little memory prepare nothing ahead: each choice compiles when made. */
function canPrewarm() {
  return ((navigator as Navigator & { deviceMemory?: number }).deviceMemory ?? 8) > 2
}

/**
 * Prepares what the visitor has not picked yet, so choosing it never stalls on shader
 * compilation: a few seconds after the scene's first picture, each group of options (catalog
 * items, each finish, each floor, the additions) is drawn once in its own idle moment, out of
 * sight below the ground, then dropped. One small group per frame keeps every compile short
 * instead of one long stall. Built from the same builders and material library the scene uses,
 * so the compiled pipelines are the ones reused.
 */
export function Prewarm({ config }: { config: Config }) {
  const { scene, invalidate } = useThree()
  const family = config.family,
    length = config.length
  useEffect(() => {
    let cancelled = false
    const group = new Group()
    group.position.y = -400
    const disposable: Mesh[] = []
    const add = (parts: Part[], own = true) => {
      for (const b of batch(parts)) {
        const mesh = new Mesh(b.geometry, b.material)
        mesh.frustumCulled = false
        mesh.userData.noProbe = true
        group.add(mesh)
        if (own) disposable.push(mesh)
      }
    }
    const steps: (() => void)[] = [
      () => {
        for (const item of CATALOG)
          for (const b of equipmentBatches(item.id)) {
            const mesh = new Mesh(b.geometry, b.material)
            mesh.frustumCulled = false
            mesh.userData.noProbe = true
            group.add(mesh)
          }
      },
      ...FINISHES.map((finish) => () => {
        const c: Config = { ...config, finish: finish.id }
        add(family === 'studio' ? studioShell(c) : containerShell(c))
      }),
      ...FLOORS.map((floor) => () => {
        const c: Config = { ...config, flooring: floor.id, finish: 'obsidian' }
        add(family === 'studio' ? studioInterior(c) : containerInterior(c))
        add(
          family === 'studio'
            ? studioInterior({ ...c, finish: 'chalk' })
            : containerInterior({ ...c, finish: 'chalk' }),
        )
      }),
      () => {
        if (family !== 'studio') return
        const all: Config = {
          ...config,
          addons: { deck: true, gazebo: true, roof: true, stairs: true },
          accent: true,
        }
        for (const build of [deck, pergola, roofDeck, stairs, timberAccent]) add(build(all))
        add(deck({ ...all, lights: !config.lights }))
      },
    ]
    let next = 0
    let cancelDraw = () => {}
    let timer: ReturnType<typeof setTimeout> | undefined
    const run = () => {
      if (cancelled || next >= steps.length) return
      group.clear()
      steps[next++]()
      if (!group.children.length) {
        idle(run)
        return
      }
      // One frame through the live pipeline compiles this group, then it goes.
      scene.add(group)
      invalidate()
      cancelDraw = sceneProgress.afterNextDraw(() => {
        scene.remove(group)
        invalidate()
        idle(run)
      })
    }
    // Waits for the scene's own first picture, then a quiet moment, before adding work.
    const start = canPrewarm()
      ? sceneProgress.afterNextDraw(() => {
          timer = setTimeout(() => idle(run), START_AFTER_MS)
        })
      : () => {}
    return () => {
      cancelled = true
      start()
      clearTimeout(timer)
      cancelDraw()
      scene.remove(group)
      disposable.forEach((mesh) => mesh.geometry.dispose())
    }
    // Rebuilt per product and size only; a finish or floor change keeps what was prepared.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [family, length, scene, invalidate])
  return null
}

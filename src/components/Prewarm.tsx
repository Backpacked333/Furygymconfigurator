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
import { sceneProgress } from '../render/progress'
import { equipmentBatches } from '../render/equipment'

const idle = (callback: () => void) =>
  (window.requestIdleCallback ?? ((f: () => void) => setTimeout(f, 200)))(callback)

/**
 * Prepares what the visitor has not picked yet, so choosing it in the 360 view never stalls on
 * shader compilation: when the scene is idle, every catalog item, addition, finish and floor of
 * this product is drawn once, out of sight below the ground, then dropped. Built from the same
 * builders and material library the scene uses, so the compiled pipelines are the ones reused.
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
    const run = () => {
      if (cancelled) return
      if (next < steps.length) {
        steps[next++]()
        idle(run)
        return
      }
      // One frame through the live pipeline compiles everything, then it all goes.
      scene.add(group)
      invalidate()
      cancelDraw = sceneProgress.afterNextDraw(() => {
        scene.remove(group)
        invalidate()
      })
    }
    let cancelDraw = () => {}
    // Waits for the scene's own first picture before adding work.
    const start = sceneProgress.afterNextDraw(() => idle(run))
    return () => {
      cancelled = true
      start()
      cancelDraw()
      scene.remove(group)
      disposable.forEach((mesh) => mesh.geometry.dispose())
    }
    // Rebuilt per product and size only; a finish or floor change keeps what was prepared.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [family, length, scene, invalidate])
  return null
}

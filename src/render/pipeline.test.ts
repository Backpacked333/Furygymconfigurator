// @vitest-environment jsdom
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { AgXToneMapping, type Node } from 'three/webgpu'
import { uniform, vec4 } from 'three/tsl'
import { STILL_BLOOM, rasterFinish, stillFinish } from './pipeline'

/** The render server's finishing of the cloud's stills, which this device's must match. */
const FINISHING = readFileSync('render-server/fury_render/finishing.py', 'utf8')
const constant = (name: string) => {
  const found = new RegExp(`^${name} = ([\\d.]+)$`, 'm').exec(FINISHING)
  if (!found) throw new Error(`${name} is not in finishing.py`)
  return Number(found[1])
}

type Visited = Node & { scope?: string; constructor: { type?: string } }
/** Every node the finished output is made from. */
function nodesOf(output: Node) {
  const nodes: Visited[] = []
  output.traverse((node) => {
    nodes.push(node as Visited)
  })
  return nodes
}
const ofType = (nodes: Visited[], type: string) => nodes.filter((n) => n.constructor.type === type)

describe("this device's still finishing", () => {
  const exposure = uniform(1.4)
  const { output, glow } = stillFinish(vec4(1, 1, 1, 1), exposure)
  const nodes = nodesOf(output)

  it('blooms as the cloud does', () => {
    const blooms = ofType(nodes, 'BloomNode')
    expect(blooms).toEqual([glow])
    expect(glow.strength.value).toBe(constant('BLOOM_STRENGTH'))
    expect(glow.threshold.value).toBe(constant('BLOOM_THRESHOLD'))
    expect((glow as unknown as { smoothWidth: { value: number } }).smoothWidth.value).toBe(
      constant('BLOOM_SMOOTH'),
    )
    // BloomNode weighs its five mips by mix(f, 1.2 - f, radius); the server folds that into one
    // factor, which only a radius of 0.5 gives every mip alike.
    expect(glow.radius.value).toBe(STILL_BLOOM.radius)
    for (const f of [1, 0.8, 0.6, 0.4, 0.2])
      expect(f + (1.2 - 2 * f) * STILL_BLOOM.radius).toBeCloseTo(constant('BLOOM_MIP_FACTOR'), 9)
  })

  it("tone maps with AgX at the still's own exposure, not the renderer's", () => {
    const mapped = ofType(nodes, 'ToneMappingNode') as unknown as {
      getToneMapping: () => number
      exposureNode: Node
    }[]
    expect(mapped).toHaveLength(1)
    expect(mapped[0].getToneMapping()).toBe(AgXToneMapping)
    expect(mapped[0].exposureNode).toBe(exposure)
    expect(FINISHING).toMatch(/display = srgb_encode\(agx\(exposed, exposure\)\)/)
  })

  it('has no vignette: nothing depends on where on the screen a pixel is but the dither', () => {
    const screen = ofType(nodes, 'ScreenNode')
    // The dither reads the pixel coordinate; a vignette reads the screen position (screenUV).
    expect(screen.length).toBeGreaterThan(0)
    expect(screen.every((n) => n.scope === 'coordinate')).toBe(true)
  })
})

describe("the live view's finishing", () => {
  const nodes = nodesOf(rasterFinish(vec4(1, 1, 1, 1)))

  it("tone maps with AgX, as the stills do, whatever the renderer's own setting", () => {
    // R3F's Canvas sets ACES Filmic on the renderer; the pipeline names AgX itself.
    const output = ofType(nodes, 'RenderOutputNode') as unknown as {
      getToneMapping: () => number
    }[]
    expect(output).toHaveLength(1)
    expect(output[0].getToneMapping()).toBe(AgXToneMapping)
  })

  it('has no vignette either', () => {
    const screen = ofType(nodes, 'ScreenNode')
    expect(screen.every((n) => n.scope === 'coordinate')).toBe(true)
  })
})

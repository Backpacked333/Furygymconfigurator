// @vitest-environment jsdom
import { createHash } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import { DirectionalLight, PerspectiveCamera, Scene, type Node } from 'three/webgpu'
import { createPipeline } from './pipeline'

/** What each build made: its render pipelines (whose output graph is read) and its SSR and SSGI. */
const made = vi.hoisted(() => ({
  pipelines: [] as { outputNode: unknown }[],
  ssr: 0,
  ssgi: 0,
}))
vi.mock('three/webgpu', async (original) => {
  const real = (await original()) as typeof import('three/webgpu')
  class RecordedPipeline extends real.RenderPipeline {
    constructor(...args: ConstructorParameters<typeof real.RenderPipeline>) {
      super(...args)
      made.pipelines.push(this)
    }
  }
  return { ...real, RenderPipeline: RecordedPipeline }
})
vi.mock('three/addons/tsl/display/SSRNode.js', async (original) => {
  const real = (await original()) as { ssr: (...args: unknown[]) => unknown }
  return {
    ssr: (...args: unknown[]) => {
      made.ssr++
      return real.ssr(...args)
    },
  }
})
vi.mock('three/addons/tsl/display/SSGINode.js', async (original) => {
  const real = (await original()) as { ssgi: (...args: unknown[]) => unknown }
  return {
    ssgi: (...args: unknown[]) => {
      made.ssgi++
      return real.ssgi(...args)
    },
  }
})

type Visited = Node & {
  constructor: { type?: string }
  isUniformNode?: boolean
  value?: unknown
}
/**
 * The output graph as one line per node, in traversal order: its type and, for a uniform, its
 * value. Textures are named by name, type and format, never by their per-run UUIDs. Two builds
 * with equal fingerprints draw the same passes with the same settings.
 */
function fingerprint(output: Node) {
  const lines: string[] = []
  output.traverse((visited) => {
    const node = visited as Visited
    let value = ''
    if (node.isUniformNode) {
      const raw = node.value as
        | { isTexture?: boolean; name?: string; type?: number; format?: number }
        | { toArray?: () => number[] }
        | number
        | boolean
        | null
      if (raw && typeof raw === 'object') {
        if ('isTexture' in raw && raw.isTexture)
          value = `texture:${raw.name}:${raw.type}:${raw.format}`
        else if ('toArray' in raw && raw.toArray) value = JSON.stringify(raw.toArray())
        else value = 'object'
      } else value = JSON.stringify(raw)
    }
    lines.push(`${node.constructor.type}${value ? `=${value}` : ''}`)
  })
  return lines
}

/** Builds a tier's pipeline against a GPU-less renderer: TSL builds its node graph on the CPU. */
function build(quality: 'lite' | 'high' | 'ultra') {
  made.pipelines.length = 0
  made.ssr = made.ssgi = 0
  const scene = new Scene()
  const sun = new DirectionalLight()
  sun.userData.sun = true
  scene.add(sun)
  const camera = new PerspectiveCamera(34, 1.6, 0.1, 2000)
  const pipeline = createPipeline({} as never, scene, camera, quality)
  expect(made.pipelines).toHaveLength(1)
  return {
    pipeline,
    ssr: made.ssr,
    ssgi: made.ssgi,
    graph: fingerprint(made.pipelines[0].outputNode as Node),
  }
}

/** A fingerprint's length and digest: equal for equal graphs. */
const digest = (graph: string[]) => ({
  nodes: graph.length,
  sha256: createHash('sha256').update(graph.join('\n')).digest('hex').slice(0, 16),
})

/**
 * Each tier's graph as captured before the live view's frame guard gave createPipeline optional
 * extras: a caller that passes none (the legacy route, the display and capture pages) must keep
 * exactly this graph. Written by hand, never by a snapshot update; a three.js upgrade that
 * reshapes its nodes changes them, and is the only reason to.
 */
const CAPTURED = {
  lite: { ssr: 0, ssgi: 0, settleFrames: 1, nodes: 20, sha256: 'fbf8706ba4d5b5ee' },
  high: { ssr: 0, ssgi: 0, settleFrames: 28, nodes: 127, sha256: '95fe42fefdf3d3c5' },
  ultra: { ssr: 1, ssgi: 1, settleFrames: 40, nodes: 394, sha256: '6c9e0cca5af8ebc2' },
} as const

describe("each tier's raster pipeline (CPU node graph, not a GPU test)", () => {
  for (const quality of ['lite', 'high', 'ultra'] as const)
    it(`builds the same ${quality} graph it always has`, () => {
      const built = build(quality)
      expect({
        ssr: built.ssr,
        ssgi: built.ssgi,
        settleFrames: built.pipeline.settleFrames,
        ...digest(built.graph),
      }).toEqual(CAPTURED[quality])
    })
})

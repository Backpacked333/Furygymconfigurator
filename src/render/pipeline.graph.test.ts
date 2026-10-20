// @vitest-environment jsdom
import { createHash } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import { DirectionalLight, PerspectiveCamera, Scene, type Node } from 'three/webgpu'
import { createPipeline, type PipelineExtras } from './pipeline'

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

type Pass = Node & {
  isPassNode?: boolean
  transparent: boolean
  opaque: boolean
  options: { samples?: number }
  getMRT: () => { outputNodes: Record<string, Node> } | null
}
/**
 * The scene passes the output draws from, in traversal order, with what each renders: its
 * attachments (an MRT layout the graph above need not read), its surfaces and its multisampling.
 */
function passesOf(output: Node) {
  const seen = new Set<Pass>()
  output.traverse((visited) => {
    if ((visited as Pass).isPassNode) seen.add(visited as Pass)
  })
  return [...seen].map((pass) => ({
    attachments: Object.keys(pass.getMRT()?.outputNodes ?? { output: true }),
    transparent: pass.transparent,
    opaque: pass.opaque,
    samples: pass.options.samples ?? null,
  }))
}

/** Builds a tier's pipeline against a GPU-less renderer: TSL builds its node graph on the CPU. */
function build(quality: 'lite' | 'high' | 'ultra', extras?: PipelineExtras) {
  made.pipelines.length = 0
  made.ssr = made.ssgi = 0
  const scene = new Scene()
  const sun = new DirectionalLight()
  sun.userData.sun = true
  scene.add(sun)
  const camera = new PerspectiveCamera(34, 1.6, 0.1, 2000)
  const pipeline = extras
    ? createPipeline({} as never, scene, camera, quality, extras)
    : createPipeline({} as never, scene, camera, quality)
  expect(made.pipelines).toHaveLength(1)
  return {
    pipeline,
    ssr: made.ssr,
    ssgi: made.ssgi,
    graph: fingerprint(made.pipelines[0].outputNode as Node),
    passes: passesOf(made.pipelines[0].outputNode as Node),
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

/**
 * Each tier's scene passes, captured from createPipeline as it was before the extras (the graph's
 * fingerprint does not see an attachment nothing reads, which still costs a render target).
 */
const scenePass = (attachments: string[], samples: number | null = null) => ({
  attachments,
  transparent: true,
  opaque: true,
  samples,
})
const prePass = (attachments: string[]) => ({
  attachments,
  transparent: false,
  opaque: true,
  samples: null,
})
const PASSES = {
  lite: [scenePass(['output'], 4)],
  high: [scenePass(['output']), prePass(['output', 'velocity'])],
  ultra: [scenePass(['output', 'diffuseColor']), prePass(['output', 'velocity', 'metalrough'])],
}

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

  for (const quality of ['lite', 'high', 'ultra'] as const)
    it(`renders the same ${quality} passes into the same attachments as it always has`, () => {
      expect(build(quality).passes).toEqual(PASSES[quality])
    })

  it("builds each tier's own passes when extras name them as the tier has them", () => {
    for (const quality of ['lite', 'high', 'ultra'] as const) {
      const own = quality === 'ultra'
      const tier = build(quality)
      for (const extras of [{ reflections: own, gi: own }, {}]) {
        const named = build(quality, extras)
        expect(named.graph).toEqual(tier.graph)
        expect(named.passes).toEqual(tier.passes)
      }
    }
  })

  it('builds Ultra without its screen-space GI and reflections where asked, settling as High does', () => {
    const lean = build('ultra', { reflections: false, gi: false })
    expect([lean.ssr, lean.ssgi, lean.pipeline.settleFrames]).toEqual([0, 0, 28])
    expect(lean.graph).not.toContain('SSGINode')
    expect(lean.graph).not.toContain('SSRNode')
    // Its output and its passes are High's, without the attachments only GI and reflections read;
    // its contact shadows (in the scene's lighting, not this graph) stay Ultra's, following the tier.
    const high = build('high')
    expect(lean.graph).toEqual(high.graph)
    expect(lean.passes).toEqual(high.passes)
    // Each switch on its own.
    const reflections = build('ultra', { gi: false })
    expect([reflections.ssr, reflections.ssgi, reflections.pipeline.settleFrames]).toEqual([
      1, 0, 28,
    ])
    expect(reflections.passes.map((pass) => pass.attachments)).toEqual([
      ['output'],
      ['output', 'velocity', 'metalrough'],
    ])
    const gi = build('ultra', { reflections: false })
    expect([gi.ssr, gi.ssgi, gi.pipeline.settleFrames]).toEqual([0, 1, 40])
    expect(gi.passes.map((pass) => pass.attachments)).toEqual([
      ['output', 'diffuseColor'],
      ['output', 'velocity'],
    ])
  })

  it('leaves Lite as it is, whatever the extras: it has no pre-pass for them', () => {
    const lite = build('lite', { reflections: true, gi: true })
    expect([lite.ssr, lite.ssgi, lite.pipeline.settleFrames]).toEqual([0, 0, 1])
    expect(lite.graph).toEqual(build('lite').graph)
    expect(lite.passes).toEqual(PASSES.lite)
  })
})

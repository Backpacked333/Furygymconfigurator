// @vitest-environment jsdom
import { Texture } from 'three'
import type { MeshStandardNodeMaterial, Node } from 'three/webgpu'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { groundMaterial } from './ground'
import { loadedMaps, textureMaps, texturesArrived, type Maps } from './materials'

// The scans' loading is stubbed: these tests cover what the ground does as they arrive.
vi.mock('./materials', async (original) => ({
  ...(await original<typeof import('./materials')>()),
  loadedMaps: vi.fn(() => undefined),
  textureMaps: vi.fn(),
  texturesArrived: vi.fn(),
}))

const scans = (): Required<Maps> => ({
  albedo: new Texture(),
  normal: new Texture(),
  arm: new Texture(),
})
/** The textures a material's nodes sample. */
function sampled(material: MeshStandardNodeMaterial) {
  const textures = new Set<Texture>()
  for (const root of [material.colorNode, material.roughnessNode, material.normalNode])
    root?.traverse((node: Node) => {
      const t = node as Node & { isTextureNode?: boolean; value?: Texture }
      if (t.isTextureNode && t.value) textures.add(t.value)
    })
  return textures
}
const traced = (material: { userData: Record<string, unknown> }) =>
  material.userData.pathTrace as Record<string, unknown>

describe('the ground', () => {
  beforeEach(() => {
    vi.mocked(loadedMaps).mockReturnValue(undefined)
    vi.mocked(textureMaps).mockReset()
    vi.mocked(texturesArrived).mockClear()
  })

  it('keeps one material through its scans arriving, which it binds in place', async () => {
    let arrive!: (maps: Maps) => void
    const arriving = new Promise<Maps>((resolve) => (arrive = resolve))
    // The lawn's scans arrive; any other set's never do.
    vi.mocked(textureMaps).mockImplementation((set) =>
      set === 'leafy_grass' ? arriving : new Promise(() => {}),
    )
    const m = groundMaterial('leafy_grass', 6.56, '#b9d49a')
    // Asked again: the same, as the library's materials.
    expect(groundMaterial('leafy_grass', 6.56, '#b9d49a')).toBe(m)
    expect(groundMaterial('dry_ground_01', 13.1, '#f4e6d2')).not.toBe(m)
    // Before the scans: the neutral stand-ins, and the plain tint for the tracers.
    const standIns = sampled(m)
    expect(standIns.size).toBe(3)
    expect(traced(m).map).toBeUndefined()
    expect(traced(m).color).toBeDefined()
    const loaded = scans()
    arrive(loaded)
    await vi.waitFor(() => expect(texturesArrived).toHaveBeenCalledTimes(1))
    // The same material, now sampling the scans, and tracing them.
    expect(groundMaterial('leafy_grass', 6.56, '#b9d49a')).toBe(m)
    expect(sampled(m)).toEqual(new Set([loaded.albedo, loaded.normal, loaded.arm]))
    expect(traced(m)).toMatchObject({
      map: loaded.albedo,
      normalMap: loaded.normal,
      roughnessMap: loaded.arm,
    })
    expect(m.version).toBe(0)
  })

  it('binds scans that are in already at once, telling no one', () => {
    const loaded = scans()
    vi.mocked(loadedMaps).mockReturnValue(loaded)
    const m = groundMaterial('clean_pebbles', 6.56, '#d8d2c4')
    expect(textureMaps).not.toHaveBeenCalled()
    expect(texturesArrived).not.toHaveBeenCalled()
    expect(sampled(m)).toEqual(new Set([loaded.albedo, loaded.normal, loaded.arm]))
    expect(traced(m).map).toBe(loaded.albedo)
  })
})

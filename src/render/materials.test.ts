// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import {
  DataUtils,
  LinearFilter,
  LinearMipmapLinearFilter,
  NoColorSpace,
  RepeatWrapping,
  SRGBColorSpace,
  Texture,
  UVMapping,
  type DataTexture,
} from 'three'
import { material, materialLoaded, quietly, textureProgress } from './materials'

const texel = (t: Texture | null) => Array.from((t as DataTexture).image.data as ArrayLike<number>)

describe('textured materials before their scans arrive', () => {
  it('bind neutral maps that look like none, so arriving scans need no recompile', () => {
    const m = material({ set: 'rubber_tiles', color: '#353936' })
    expect(texel(m.map)).toEqual([255, 255, 255, 255])
    expect(texel(m.normalMap).map((v) => DataUtils.fromHalfFloat(v))).toEqual([0.5, 0.5, 1, 1])
    expect(texel(m.roughnessMap)).toEqual([255, 255, 255, 255])
    // No baked occlusion: the stills never see one (materials.ts applyMaps).
    expect(m.aoMap).toBeNull()
    expect(m.metalnessMap).toBeNull()
    expect(m.version).toBe(0)
  })

  it('match the sampler state and color spaces the scans use', () => {
    const m = material({ set: 'oak_veneer_01', color: '#b08c61' })
    for (const t of [m.map!, m.normalMap!, m.roughnessMap!]) {
      expect(t.mapping).toBe(UVMapping)
      expect([t.wrapS, t.wrapT]).toEqual([RepeatWrapping, RepeatWrapping])
      expect([t.magFilter, t.minFilter]).toEqual([LinearFilter, LinearMipmapLinearFilter])
    }
    expect(m.map!.colorSpace).toBe(SRGBColorSpace)
    expect(m.normalMap!.colorSpace).toBe(NoColorSpace)
    expect(m.roughnessMap!.colorSpace).toBe(NoColorSpace)
  })

  it('leave detail-only sets without albedo and give metallic sets a metalness map', () => {
    const m = material({ set: 'brushed_metal', color: '#888888', metalness: 1 })
    expect(m.map).toBeNull()
    expect(m.normalMap).not.toBeNull()
    expect(m.metalnessMap).toBe(m.roughnessMap)
  })
})

describe('surfaces built for a design the page does not show (the stills prefetch)', () => {
  it('download their scans out of the page’s progress until a surface on screen asks for them', () => {
    const before = textureProgress.get()
    const spec = { set: 'hinoki_planks' as const, color: '#123456' }
    const unseen = quietly(() => material(spec))
    expect(textureProgress.get()).toEqual(before)
    expect(materialLoaded(unseen)).toBe(false)
    // Built again for the page (a click on the design): the same surface, its scans now counted.
    expect(material(spec)).toBe(unseen)
    expect(textureProgress.get()).toEqual({
      requested: before.requested + 3,
      loaded: before.loaded,
    })
    // Asked for again on screen: counted once.
    material(spec)
    expect(textureProgress.get().requested).toBe(before.requested + 3)
  })

  it('count a set loading quietly once another surface on screen needs it', () => {
    const before = textureProgress.get()
    quietly(() => material({ set: 'teak_veneer', color: '#aa8866' }))
    expect(textureProgress.get()).toEqual(before)
    material({ set: 'teak_veneer', color: '#ffffff' })
    expect(textureProgress.get().requested).toBe(before.requested + 3)
  })

  it('need no scans when they have no set', () => {
    expect(materialLoaded(quietly(() => material({ color: '#334455' })))).toBe(true)
  })

  it('say when a quiet download failed, without waiting through its later rounds', async () => {
    // A fresh library whose downloads all fail, decoded off the main thread as in a browser.
    vi.resetModules()
    vi.useFakeTimers()
    vi.stubGlobal('createImageBitmap', vi.fn())
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('', { status: 404 })),
    )
    try {
      const fresh = await import('./materials')
      const surface = fresh.quietly(() => fresh.material({ set: 'granite_tile_04', color: '#888' }))
      const settled = vi.fn()
      void fresh.whenMaterialLoaded(surface).then(settled)
      // Each map is tried three times, a second and then two apart.
      await vi.advanceTimersByTimeAsync(3000)
      expect(settled).toHaveBeenCalledWith(false)
      expect(fresh.materialLoaded(surface)).toBe(false)
    } finally {
      vi.unstubAllGlobals()
      vi.useRealTimers()
      vi.resetModules()
    }
  })
})

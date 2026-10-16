// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
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
import { material } from './materials'

const texel = (t: Texture | null) => Array.from((t as DataTexture).image.data as ArrayLike<number>)

describe('textured materials before their scans arrive', () => {
  it('bind neutral maps that look like none, so arriving scans need no recompile', () => {
    const m = material({ set: 'rubber_tiles', color: '#353936' })
    expect(texel(m.map)).toEqual([255, 255, 255, 255])
    expect(texel(m.normalMap).map((v) => DataUtils.fromHalfFloat(v))).toEqual([0.5, 0.5, 1, 1])
    expect(texel(m.roughnessMap)).toEqual([255, 255, 255, 255])
    expect(m.aoMap).toBe(m.roughnessMap)
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

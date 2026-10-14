import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { NoColorSpace, SRGBColorSpace } from 'three'

type Library = typeof import('./materials')
let library: Library
let releases: (() => void)[]
let unavailable: Set<string>
let decodeFailure = false
const bitmap = () => ({ width: 16, height: 16, close: vi.fn() }) as unknown as ImageBitmap
const flush = async () => {
  for (let i = 0; i < 30; i++) await Promise.resolve()
}

beforeEach(async () => {
  vi.resetModules()
  vi.useFakeTimers()
  unavailable = new Set()
  releases = []
  decodeFailure = false
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      const fail = [...unavailable].some((role) => url.includes(`/${role}.webp`))
      return { ok: !fail, status: fail ? 503 : 200, blob: async () => new Blob() }
    }),
  )
  vi.stubGlobal(
    'createImageBitmap',
    vi.fn(async () => {
      if (decodeFailure) throw new Error('Decode error')
      return bitmap()
    }),
  )
  library = await import('./materials')
})
afterEach(async () => {
  releases.forEach((release) => release())
  await flush()
  vi.clearAllTimers()
  vi.useRealTimers()
  vi.unstubAllGlobals()
})
function own(spec: Parameters<Library['material']>[0]) {
  const m = library.material(spec)
  releases.push(library.retainMaterials([m]))
  return m
}
async function failAndAutoRetry() {
  await flush()
  await vi.advanceTimersByTimeAsync(300)
  await flush()
}

describe('recoverable maps and material ownership', () => {
  it('does no network work for uncommitted material creation', () => {
    library.material({ set: 'teak_veneer' })
    expect(fetch).not.toHaveBeenCalled()
    expect(library.textureProgress.snapshot().requested).toBe(0)
  })
  it.each(['albedo', 'normal', 'arm'])(
    'retains siblings when %s fails, retries only that map, and rebinds in place',
    async (role) => {
      unavailable.add(role)
      const m = own({ set: 'oak_veneer_01' })
      const changed = vi.fn()
      releases.push(library.onMaterialsChanged(changed))
      await failAndAutoRetry()
      expect(library.textureProgress.snapshot()).toMatchObject({
        ready: 2,
        failed: 1,
        degraded: 1,
        settled: true,
        loaded: 3,
      })
      const before = { albedo: m.map, normal: m.normalMap, arm: m.aoMap }
      const version = m.version
      expect(fetch).toHaveBeenCalledTimes(4)
      unavailable.clear()
      library.textureProgress.retry()
      await flush()
      expect(fetch).toHaveBeenCalledTimes(5)
      expect(library.textureProgress.snapshot()).toMatchObject({
        ready: 3,
        failed: 0,
        degraded: 0,
        pending: 0,
      })
      const after = { albedo: m.map, normal: m.normalMap, arm: m.aoMap }
      for (const key of ['albedo', 'normal', 'arm'] as const) {
        if (key === role) expect(after[key]).not.toBe(before[key])
        else expect(after[key]).toBe(before[key])
      }
      expect(m.version).toBeGreaterThan(version)
      expect(changed).toHaveBeenCalledWith('textures')
    },
  )
  it('keeps intentional fallback maps after all failures and bounds repeated manual retries', async () => {
    unavailable = new Set(['albedo', 'normal', 'arm'])
    const m = own({ set: 'rubber_tiles' })
    await failAndAutoRetry()
    expect(m.normalMap?.name).toBe('fallback:rubber_tiles/normal')
    expect(library.textureProgress.snapshot()).toMatchObject({
      loaded: 3,
      ready: 0,
      failed: 3,
      settled: true,
      canRetry: true,
    })
    for (let i = 0; i < 20; i++) library.textureProgress.retry()
    await flush()
    for (let i = 0; i < 20; i++) library.textureProgress.retry()
    expect(fetch).toHaveBeenCalledTimes(9)
    expect(library.textureProgress.snapshot().canRetry).toBe(false)
    await vi.advanceTimersByTimeAsync(60000)
    expect(fetch).toHaveBeenCalledTimes(9)
  })
  it('recovers from decode failures without retaining a rejected promise', async () => {
    decodeFailure = true
    own({ set: 'rubber_tiles' })
    await failAndAutoRetry()
    expect(library.textureProgress.snapshot().failed).toBe(3)
    decodeFailure = false
    library.textureProgress.retry()
    await flush()
    expect(library.textureProgress.snapshot().ready).toBe(3)
  })
  it('times out stalled decoding, reports degradation, and closes late bitmaps', async () => {
    const completions: ((image: ImageBitmap) => void)[] = []
    vi.mocked(createImageBitmap).mockImplementation(
      () => new Promise((resolve) => completions.push(resolve)),
    )
    own({ set: 'powder_coat' })
    await flush()
    await vi.advanceTimersByTimeAsync(16300)
    expect(library.textureProgress.snapshot()).toMatchObject({
      ready: 0,
      failed: 2,
      pending: 0,
      settled: true,
    })
    const images = completions.map(() => bitmap())
    completions.forEach((complete, i) => complete(images[i]))
    await flush()
    images.forEach((image) => expect(image.close).toHaveBeenCalledOnce())
    expect(library.textureProgress.snapshot().ready).toBe(0)
  })
  it('shares maps and disposes exactly once only after the last consumer releases', async () => {
    const a = own({ set: 'oak_veneer_01', color: '#aaa' })
    const b = own({ set: 'oak_veneer_01', color: '#bbb' })
    await flush()
    expect(fetch).toHaveBeenCalledTimes(3)
    expect(a.map).toBe(b.map)
    const disposal = vi.fn()
    b.map!.addEventListener('dispose', disposal)
    releases[0]()
    expect(disposal).not.toHaveBeenCalled()
    expect(library.materialInventory().activeSets).toBe(1)
    releases[1]()
    releases[1]()
    expect(disposal).toHaveBeenCalledOnce()
    expect(library.materialInventory()).toMatchObject({
      activeSets: 0,
      owners: 0,
      textureWrappers: 0,
    })
  })
  it('does not update externally disposed materials when pending images finish', async () => {
    const completions: ((image: ImageBitmap) => void)[] = []
    vi.mocked(createImageBitmap).mockImplementation(
      () => new Promise((resolve) => completions.push(resolve)),
    )
    const m = own({ set: 'oak_veneer_01' })
    await flush()
    m.dispose()
    const version = m.version
    const images = completions.map(() => bitmap())
    completions.forEach((complete, i) => complete(images[i]))
    await flush()
    expect(m.version).toBe(version)
    images.forEach((image) => expect(image.close).toHaveBeenCalledOnce())
    expect(library.materialInventory().cpuSources).toBe(0)
  })
  it('creates fresh generation textures from CPU sources without refetching', async () => {
    const m = own({ set: 'oak_veneer_01' })
    await flush()
    const previous = m.map!
    const disposal = vi.fn()
    previous.addEventListener('dispose', disposal)
    library.setMaterialGeneration(7)
    await flush()
    expect(fetch).toHaveBeenCalledTimes(3)
    expect(m.map).not.toBe(previous)
    expect(m.map!.image).toBe(previous.image)
    expect(disposal).toHaveBeenCalledOnce()
    expect(library.textureProgress.snapshot()).toMatchObject({ generation: 7, ready: 3 })
  })
  it('ignores old-generation completions while rebinding the active generation', async () => {
    const completions: ((image: ImageBitmap) => void)[] = []
    vi.mocked(createImageBitmap).mockImplementation(
      () => new Promise((resolve) => completions.push(resolve)),
    )
    const m = own({ set: 'powder_coat' })
    await flush()
    library.setMaterialGeneration(1)
    await flush()
    const old = [bitmap(), bitmap()]
    completions[0](old[0])
    completions[1](old[1])
    await flush()
    expect(library.textureProgress.snapshot()).toMatchObject({
      generation: 1,
      ready: 0,
      pending: 2,
    })
    expect(m.normalMap!.name).toBe('fallback:powder_coat/normal')
    old.forEach((image) => expect(image.close).toHaveBeenCalledOnce())
    completions[2](bitmap())
    completions[3](bitmap())
    await flush()
    expect(library.textureProgress.snapshot().ready).toBe(2)
  })
  it('uses sRGB only for color, shares linear ARM channels, and respects material metallicity', async () => {
    const wood = own({ set: 'oak_veneer_01' })
    const metal = own({ set: 'brushed_metal', metalness: 1 })
    await flush()
    expect(wood.map!.colorSpace).toBe(SRGBColorSpace)
    expect(wood.normalMap!.colorSpace).toBe(NoColorSpace)
    expect(wood.aoMap!.colorSpace).toBe(NoColorSpace)
    expect(wood.roughnessMap).toBe(wood.aoMap)
    expect(wood.metalnessMap).toBeNull()
    expect(metal.metalnessMap).toBe(metal.roughnessMap)
    expect(wood.map!.repeat.x).toBeCloseTo(1 / 6.004)
    library.setMaxAnisotropy(2)
    expect(wood.map!.anisotropy).toBe(2)
  })
  it('reports the same material in each active owner scope without premature disposal', async () => {
    const m = library.material({ set: 'oak_veneer_01' })
    const first = library.retainMaterials([m], 'scene:first')
    const second = library.retainMaterials([m], 'scene:second')
    releases.push(first, second)
    await flush()
    expect(fetch).toHaveBeenCalledTimes(3)
    expect(library.textureProgress.snapshot('scene:first')).toMatchObject({
      requested: 3,
      ready: 3,
    })
    expect(library.textureProgress.snapshot('scene:second')).toMatchObject({
      requested: 3,
      ready: 3,
    })
    expect(library.textureProgress.snapshot('scene')).toMatchObject({ requested: 3, owners: 2 })
    const disposed = vi.fn()
    m.addEventListener('dispose', disposed)
    first()
    expect(library.textureProgress.snapshot('scene:first').requested).toBe(0)
    expect(library.textureProgress.snapshot('scene:second').ready).toBe(3)
    expect(disposed).not.toHaveBeenCalled()
    second()
    expect(disposed).toHaveBeenCalledOnce()
  })
  it('does not exhaust retry limits merely by cancelling uncommitted generations', async () => {
    vi.mocked(createImageBitmap).mockImplementation(() => new Promise(() => {}))
    const m = own({ set: 'powder_coat' })
    for (let i = 1; i < 10; i++) {
      await flush()
      library.setMaterialGeneration(i)
    }
    expect(library.textureProgress.snapshot()).toMatchObject({ failed: 0, pending: 2 })
    vi.mocked(createImageBitmap).mockImplementation(async () => bitmap())
    library.setMaterialGeneration(10)
    await flush()
    expect(library.textureProgress.snapshot()).toMatchObject({ ready: 2, failed: 0, pending: 0 })
    expect(m.normalMap!.name).not.toContain('fallback:')
  })
  it('bounds idle decoded source count and closes evicted bitmaps', async () => {
    for (const set of Object.keys(library.TEXTURE_SETS) as (keyof Library['TEXTURE_SETS'])[])
      own({ set })
    await flush()
    expect(library.materialInventory().cpuSources).toBe(60)
    releases.forEach((release) => release())
    expect(library.materialInventory()).toMatchObject({ activeSets: 0, cpuSources: 24 })
    const results = await Promise.all(
      vi
        .mocked(createImageBitmap)
        .mock.results.map((result) => result.value as Promise<ImageBitmap>),
    )
    expect(results.filter((image) => vi.mocked(image.close).mock.calls.length === 1)).toHaveLength(
      36,
    )
  })
  it('bounds decoded bytes and can reload a successful source after repeated cache eviction', async () => {
    vi.mocked(createImageBitmap).mockImplementation(async () => ({
      ...bitmap(),
      width: 2048,
      height: 2048,
    }))
    for (let cycle = 0; cycle < 5; cycle++) {
      for (const set of ['oak_veneer_01', 'rubber_tiles'] as const) {
        own({ set })
        await flush()
        expect(library.textureProgress.snapshot()).toMatchObject({ ready: 3, failed: 0 })
        releases.at(-1)!()
        expect(library.materialInventory().cpuDecodedBytes).toBeLessThanOrEqual(64 * 1024 * 1024)
      }
    }
  })
  it('isolates a broken consumer callback from source outcomes and other consumers', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {})
    releases.push(
      library.subscribeTextureMaps('powder_coat', () => {
        throw new Error('Consumer error')
      }),
    )
    const m = own({ set: 'powder_coat' })
    await flush()
    expect(library.textureProgress.snapshot()).toMatchObject({ ready: 2, failed: 0, settled: true })
    expect(fetch).toHaveBeenCalledTimes(2)
    expect(m.normalMap!.name).not.toContain('fallback:')
    expect(log).toHaveBeenCalled()
    log.mockRestore()
  })
  it('shares legacy one-shot leases but renews the promise for a new generation', async () => {
    const first = library.textureMaps('powder_coat')
    releases.push(() => library.releaseTextureMaps('powder_coat'))
    expect(library.textureMaps('powder_coat')).toBe(first)
    const previous = await first
    library.setMaterialGeneration(1)
    const next = library.textureMaps('powder_coat')
    expect(next).not.toBe(first)
    expect((await next).normal).not.toBe(previous.normal)
    expect(fetch).toHaveBeenCalledTimes(2)
    expect(library.materialInventory().owners).toBe(1)
  })
})

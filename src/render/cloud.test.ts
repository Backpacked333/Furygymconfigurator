// @vitest-environment jsdom
import {
  BoxGeometry,
  BufferAttribute,
  BufferGeometry,
  DataUtils,
  InterleavedBuffer,
  InterleavedBufferAttribute,
  Mesh,
  MeshStandardMaterial,
  RectAreaLight,
  Scene,
  SpotLight,
  SRGBColorSpace,
  Texture,
} from 'three/webgpu'
import { createHash } from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { skyLook } from '../lib/visuals'
import {
  captureScene,
  CloudClient,
  cloudUrl,
  encodeGeometry,
  encodeInstances,
  encodeSky,
  fingerprint,
  FRAME_TIMEOUT_MS,
  Full,
  Busy,
  Outdated,
  renderSession,
  stableJson,
  warmCloud,
  warmth,
} from './cloud'

// The sky map takes seconds to compute: a scene capture gets a tiny one.
vi.mock('./pathtrace', async (original) => {
  const actual = await original<typeof import('./pathtrace')>()
  const { DataTexture, FloatType, RGBAFormat } = await import('three/webgpu')
  const sky = new DataTexture(new Float32Array(8).fill(0.5), 2, 1, RGBAFormat, FloatType)
  return { ...actual, environmentTexture: () => sky }
})

/** A thumbnail's and an export's settings (stills.ts QUALITY). */
const THUMB = { samples: 64, threshold: 0, timeLimit: 6 }
const EXPORT = { samples: 1024, threshold: 0.01, timeLimit: 60 }
const camera = { matrix: Array(16).fill(0), fov: 34, near: 0.1, far: 2000 }
/** A frame request of a still, on the channel given. */
const still = (channel?: string) => ({
  camera,
  width: 100,
  height: 80,
  quality: THUMB,
  finish: { exposure: 1, gain: 1 },
  priority: 0,
  generation: 1,
  channel,
})
/** A finished frame as the server sends it. */
const finished = () =>
  new Response(new Uint8Array(8), { headers: { 'content-type': 'image/webp' } })

describe('cloud requests', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('reports completed uploads and image receipt, never elapsed-time render percentages', async () => {
    const key = 'a'.repeat(64)
    let finishUpload!: (response: Response) => void
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValueOnce(new Response(JSON.stringify({ missing: [key] }), { status: 409 }))
        .mockImplementationOnce(
          () =>
            new Promise<Response>((resolve) => {
              finishUpload = resolve
            }),
        )
        .mockResolvedValueOnce(finished()),
    )
    const report = vi.fn()
    const result = new CloudClient('https://gpu.example').frame(
      { scene: {} as never, blobs: new Map([[key, async () => new Uint8Array([1])]]) },
      still('f'),
      new AbortController().signal,
      report,
    )
    await vi.waitFor(() =>
      expect(report).toHaveBeenLastCalledWith({ stage: 'uploading', completed: 0, total: 1 }),
    )
    finishUpload(new Response(null, { status: 204 }))
    await result
    expect(report.mock.calls.map(([work]) => work)).toEqual([
      { stage: 'requesting' },
      { stage: 'uploading', completed: 0, total: 1 },
      { stage: 'uploading', completed: 1, total: 1 },
      { stage: 'requesting' },
      { stage: 'receiving' },
    ])
  })

  it('reports no completed upload when sending an asset fails', async () => {
    const key = 'a'.repeat(64)
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValueOnce(new Response(JSON.stringify({ missing: [key] }), { status: 409 }))
        .mockResolvedValueOnce(new Response(null, { status: 500 })),
    )
    const report = vi.fn()
    await expect(
      new CloudClient('https://gpu.example').frame(
        { scene: {} as never, blobs: new Map([[key, async () => new Uint8Array([1])]]) },
        still('f'),
        new AbortController().signal,
        report,
      ),
    ).rejects.toThrow()
    expect(report).toHaveBeenLastCalledWith({ stage: 'uploading', completed: 0, total: 1 })
  })

  it('ask for each channel on a session of its own, so none supersedes another', async () => {
    const fetch = vi.fn().mockImplementation(() => Promise.resolve(finished()))
    vi.stubGlobal('fetch', fetch)
    const client = new CloudClient('https://gpu.example')
    const captured = { scene: {} as never, blobs: new Map() }
    const signal = new AbortController().signal
    await client.frame(captured, still('f'), signal)
    await client.frame(captured, still('m'), signal)
    await client.frame(captured, still(), signal)
    const [focus, meter, rest] = fetch.mock.calls.map((call) =>
      JSON.parse(new TextDecoder().decode(call[1].body as Uint8Array)),
    )
    expect(focus.kind).toBe('spin')
    expect(focus.output).toBe('frame')
    expect(focus.quality).toEqual(THUMB)
    const base = rest.session.slice(0, -1)
    expect([focus.session, meter.session, rest.session]).toEqual([
      `${base}f`,
      `${base}m`,
      `${base}s`,
    ])
  })

  it('upload each missing blob once when two stills both need it', async () => {
    const puts: string[] = []
    let rendered = 0
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation(async (url: string, init: RequestInit) => {
        if (init.method === 'PUT') {
          puts.push(url.split('?')[0])
          await new Promise((resolve) => setTimeout(resolve, 5))
          return new Response(null, { status: 204 })
        }
        // The server lacks both blobs until they are uploaded.
        if (puts.length < 2 && rendered++ < 2)
          return new Response(JSON.stringify({ missing: ['a'.repeat(64), 'b'.repeat(64)] }), {
            status: 409,
          })
        return finished()
      }),
    )
    const blob = () => Promise.resolve(new Uint8Array([1, 2, 3]))
    const blobs = new Map([
      ['a'.repeat(64), blob],
      ['b'.repeat(64), blob],
    ])
    const client = new CloudClient('https://gpu.example')
    const signal = new AbortController().signal
    const captured = { scene: {} as never, blobs }
    await Promise.all([
      client.frame(captured, still('f'), signal),
      client.frame(captured, still(), signal),
    ])
    expect(puts.sort()).toEqual([
      `https://gpu.example/blobs/${'a'.repeat(64)}`,
      `https://gpu.example/blobs/${'b'.repeat(64)}`,
    ])
  })

  it('give up on a frame that does not come in time, as on a busy server', async () => {
    vi.useFakeTimers()
    // A connection that never answers, unless the caller gives up on it.
    vi.stubGlobal(
      'fetch',
      vi.fn(
        (_url: string, init: RequestInit) =>
          new Promise((_, reject) =>
            init.signal!.addEventListener('abort', () => reject(init.signal!.reason)),
          ),
      ),
    )
    const request = still()
    const captured = { scene: {} as never, blobs: new Map() }
    const client = new CloudClient('https://gpu.example')
    let outcome: unknown = null
    client.frame(captured, request, new AbortController().signal).catch((error) => {
      outcome = error
    })
    // Twenty seconds beyond twice the frame's own time limit.
    await vi.advanceTimersByTimeAsync(FRAME_TIMEOUT_MS + 2 * THUMB.timeLimit * 1000 - 1)
    expect(outcome).toBeNull()
    await vi.advanceTimersByTimeAsync(1)
    expect(outcome).toBeInstanceOf(Busy)
    // The caller's own abort is theirs, not a busy server.
    const own = new AbortController()
    let aborted: unknown = null
    client.frame(captured, request, own.signal).catch((error) => {
      aborted = error
    })
    own.abort(new Error('turned away'))
    await vi.advanceTimersByTimeAsync(0)
    expect(aborted).toEqual(new Error('turned away'))
    // A longer frame opened since (an export) may be rendered ahead of it on the session's one
    // GPU: it is allowed that frame's time limit too, and gives up only after it.
    const patient = new CloudClient('https://gpu.example')
    let waited: unknown = null
    patient.frame(captured, request, new AbortController().signal).catch((error) => {
      waited = error
    })
    await vi.advanceTimersByTimeAsync(1000)
    const exported = { ...request, quality: EXPORT }
    patient.frame(captured, exported, new AbortController().signal).catch(() => {})
    await vi.advanceTimersByTimeAsync(FRAME_TIMEOUT_MS + 2 * THUMB.timeLimit * 1000)
    expect(waited).toBeNull()
    await vi.advanceTimersByTimeAsync(EXPORT.timeLimit * 1000 - 1000 - 1)
    expect(waited).toBeNull()
    await vi.advanceTimersByTimeAsync(1)
    expect(waited).toBeInstanceOf(Busy)
    vi.useRealTimers()
  })

  it('take an upload the server turns away as a busy server', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation(async (_url: string, init: RequestInit) => {
        if (init.method === 'PUT') return new Response(null, { status: 503 })
        return new Response(JSON.stringify({ missing: ['a'.repeat(64)] }), { status: 409 })
      }),
    )
    const blobs = new Map([['a'.repeat(64), () => Promise.resolve(new Uint8Array([1]))]])
    const captured = { scene: {} as never, blobs }
    const signal = new AbortController().signal
    await expect(
      new CloudClient('https://gpu.example').frame(captured, still(), signal),
    ).rejects.toBeInstanceOf(Busy)
  })

  it('tell a finished frame from a server that predates finished frames', async () => {
    const request = still()
    const captured = { scene: {} as never, blobs: new Map() }
    const signal = new AbortController().signal
    const frame = new Response(new Uint8Array(8), {
      headers: {
        'content-type': 'image/webp',
        'x-traced-key': '-2.4600',
        'x-cache': 'hit',
        'x-fury-renderer': 'own',
      },
    })
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(frame))
    const finished = await new CloudClient('https://gpu.example').frame(captured, request, signal)
    expect(finished.tracedKey).toBeCloseTo(-2.46, 4)
    expect(finished.cached).toBe(true)
    expect(finished.renderer).toBe('own')
    // A gateway from before the shared renderer names none.
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(
          new Response(new Uint8Array(8), { headers: { 'content-type': 'image/webp' } }),
        ),
    )
    expect(
      (await new CloudClient('https://gpu.example').frame(captured, request, signal)).renderer,
    ).toBe('')
    // An older server ignores the frame fields and sends a view's half-float image.
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(new Uint8Array(16), {
          headers: { 'content-type': 'application/octet-stream' },
        }),
      ),
    )
    await expect(
      new CloudClient('https://gpu.example').frame(captured, request, signal),
    ).rejects.toBeInstanceOf(Outdated)
  })
})

describe('scene capture', () => {
  afterEach(() => vi.unstubAllGlobals())

  /**
   * A small gym built from scratch: a painted box, two plain ones sharing a material, a downlight
   * and a strip. `shuffled` adds them in another order, as a page might mount them.
   */
  function build(shuffled: boolean) {
    const image = document.createElement('img')
    image.src = 'https://example.test/scans/oak.png'
    const map = new Texture(image)
    map.colorSpace = SRGBColorSpace
    map.repeat.set(2, 2)
    const painted = new MeshStandardMaterial({ map, roughness: 0.4 })
    const plain = new MeshStandardMaterial({ color: 0x336699, metalness: 0.2 })
    const floor = new Mesh(new BoxGeometry(1, 2, 3), painted)
    floor.position.set(1, 0, 2)
    const bench = new Mesh(new BoxGeometry(1, 1, 1), plain)
    bench.position.set(-3, 0, 0)
    const rack = new Mesh(new BoxGeometry(1, 1, 1), plain)
    rack.position.set(0, 0, 4)
    const downlight = new SpotLight(0xffd9ad, 20)
    downlight.position.set(0, 3, 0)
    const strip = new RectAreaLight(0xffd9ad, 5, 2, 0.1)
    strip.position.set(0, 3, -2)
    const scene = new Scene()
    scene.add(
      ...(shuffled
        ? [strip, rack, downlight, bench, floor]
        : [floor, bench, rack, downlight, strip]),
    )
    return scene
  }

  it('describe the same design identically however the page built it', async () => {
    // The texture's file, and a digest for environments without WebCrypto.
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(new Uint8Array([0x89, 0x50, 0x4e, 0x47]))),
    )
    if (!globalThis.crypto?.subtle)
      vi.stubGlobal('crypto', {
        subtle: {
          digest: async (_algorithm: string, bytes: Uint8Array) =>
            createHash('sha256').update(bytes).digest().buffer,
        },
      })
    const look = skyLook('backyard', 13)
    const first = await captureScene(build(false), look)
    const second = await captureScene(build(true), look)
    expect(JSON.stringify(first.scene)).toBe(JSON.stringify(second.scene))
    const { scene } = first
    // Named by content, not by the page's uuids: three objects, two materials, one texture.
    expect(scene.objects.map((o) => o.id)).toEqual([...scene.objects.map((o) => o.id)].sort())
    expect(scene.objects).toHaveLength(3)
    expect(scene.objects.every((o) => /^[0-9a-f]{16}$/.test(o.id))).toBe(true)
    expect(Object.keys(scene.materials)).toHaveLength(2)
    expect(Object.keys(scene.materials)).toEqual(Object.keys(scene.materials).sort())
    const [texture] = Object.keys(scene.textures)
    expect(Object.keys(scene.textures)).toHaveLength(1)
    expect(scene.textures[texture]).toMatchObject({
      url: 'https://example.test/scans/oak.png',
      srgb: true,
      wrap: 'clamp',
    })
    const painted = Object.values(scene.materials).find((m) => m.maps.map)!
    expect(painted.maps.map).toBe(texture)
    // Every blob the server may ask for is on hand (protocol.py required_blobs).
    for (const o of scene.objects) expect(first.blobs.has(o.geometry)).toBe(true)
    expect(first.blobs.has(scene.textures[texture].blob)).toBe(true)
    expect(first.blobs.has(scene.environment!.blob)).toBe(true)
    // Lights in a fixed order too, the sun among them.
    expect(scene.lights.map((l) => l.type)).toEqual(
      [...scene.lights]
        .sort((a, b) => stableJson(a).localeCompare(stableJson(b)))
        .map((l) => l.type),
    )
    expect(scene.lights.some((l) => l.type === 'sun')).toBe(true)
  })

  it('describe a scanned texture by the file it was decoded from, not a PNG of its pixels', async () => {
    if (!globalThis.crypto?.subtle)
      vi.stubGlobal('crypto', {
        subtle: {
          digest: async (_algorithm: string, bytes: Uint8Array) =>
            createHash('sha256').update(bytes).digest().buffer,
        },
      })
    // A scan as materials.ts keeps it: decoded to a bitmap, with its WebP file in userData.
    const file = new Uint8Array([0x52, 0x49, 0x46, 0x46, 1, 2, 3, 4])
    const map = new Texture({ width: 2, height: 2, close() {} } as unknown as ImageBitmap)
    map.flipY = false
    // jsdom's Blob has no arrayBuffer(); every browser's has.
    map.userData.scan = Object.assign(new Blob([file]), { arrayBuffer: async () => file.buffer })
    const scene = new Scene()
    scene.add(new Mesh(new BoxGeometry(), new MeshStandardMaterial({ map })))
    const { scene: captured, blobs } = await captureScene(scene, skyLook('backyard', 13))
    const [texture] = Object.values(captured.textures)
    expect(texture).toBeDefined()
    expect(texture.url).toBeUndefined()
    expect(texture.blob).toBe(createHash('sha256').update(file).digest('hex'))
    expect(Array.from(await blobs.get(texture.blob)!())).toEqual(Array.from(file))
  })

  it('name content the same way every time, whatever the key order', () => {
    expect(fingerprint('gym')).toBe(fingerprint('gym'))
    expect(fingerprint('gym')).not.toBe(fingerprint('gyn'))
    expect(fingerprint('gym')).toMatch(/^[0-9a-f]{16}$/)
    expect(stableJson({ b: [1, { d: 2, c: 3 }], a: 'x' })).toBe('{"a":"x","b":[1,{"c":3,"d":2}]}')
    expect(stableJson({ a: undefined, b: null })).toBe('{"b":null}')
  })
})

describe('render sessions', () => {
  const signal = new AbortController().signal
  afterEach(() => vi.unstubAllGlobals())

  it('name one session for the whole page, on renders and uploads alike', async () => {
    const fetch = vi.fn().mockImplementation(async (_url: string, init: RequestInit) => {
      if (init.method === 'PUT') return new Response(null, { status: 204 })
      if (fetch.mock.calls.length === 1)
        return new Response(JSON.stringify({ missing: ['a'.repeat(64)] }), { status: 409 })
      return finished()
    })
    vi.stubGlobal('fetch', fetch)
    const blobs = new Map([['a'.repeat(64), () => Promise.resolve(new Uint8Array([1]))]])
    const captured = { scene: {} as never, blobs }
    await new CloudClient('https://gpu.example').frame(captured, still(), signal)
    // A second client on the page (one made after a lost GPU device, say) is the same session.
    await new CloudClient('https://gpu.example').frame(captured, still(), signal)
    const sessions = fetch.mock.calls.map((call) =>
      new URL(call[0] as string).searchParams.get('session'),
    )
    expect(fetch.mock.calls.map((call) => call[1].method)).toEqual(['POST', 'PUT', 'POST', 'POST'])
    expect(new Set(sessions).size).toBe(1)
    expect(sessions[0]).toMatch(/^[A-Za-z0-9_-]{8,64}$/)
  })

  it('keep the session across reloads, and make a new one when none is kept or usable', () => {
    const form = /^[A-Za-z0-9_-]{8,64}$/
    const kept = { getItem: vi.fn(() => 'kept-session_01'), setItem: vi.fn() }
    expect(renderSession(kept)).toBe('kept-session_01')
    expect(kept.setItem).not.toHaveBeenCalled()
    // Something else under the key (too short, or a stray character) is replaced.
    const stray = { getItem: vi.fn(() => 'no good!'), setItem: vi.fn() }
    const fresh = renderSession(stray)
    expect(fresh).toMatch(form)
    expect(stray.setItem).toHaveBeenCalledWith('fury-render-session', fresh)
    // Private mode: storage throws on either side, and the page still has a session.
    const forbidden = {
      getItem: vi.fn(() => {
        throw new Error('denied')
      }),
      setItem: vi.fn(() => {
        throw new Error('denied')
      }),
    }
    expect(renderSession(forbidden)).toMatch(form)
    expect(renderSession(null)).toMatch(form)
    expect(renderSession(null)).not.toBe(renderSession(null))
  })

  it('warm the session once per page, keeping what the gateway answered', async () => {
    const fetch = vi
      .fn()
      .mockResolvedValue(
        new Response(JSON.stringify({ warming: true, renderer: 'own' }), { status: 202 }),
      )
    vi.stubGlobal('fetch', fetch)
    expect(warmth.asked).toBe(false)
    warmCloud('https://gpu.example')
    warmCloud('https://gpu.example')
    expect(fetch).toHaveBeenCalledTimes(1)
    const [url, init] = fetch.mock.calls[0] as [string, RequestInit | undefined]
    const asked = new URL(url)
    expect(asked.pathname).toBe('/warm')
    expect(asked.searchParams.get('session')).toMatch(/^[A-Za-z0-9_-]{8,64}$/)
    expect(init?.body).toBeUndefined()
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(warmth).toEqual({ asked: true, status: 202, renderer: 'own' })
  })

  it('tell every GPU in use from a busy one', async () => {
    const captured = { scene: {} as never, blobs: new Map() }
    const answer = (body: object) =>
      vi.fn().mockResolvedValue(new Response(JSON.stringify(body), { status: 503 }))
    vi.stubGlobal('fetch', answer({ error: 'Every cloud GPU is in use', full: true }))
    await expect(
      new CloudClient('https://gpu.example').frame(captured, still(), signal),
    ).rejects.toBeInstanceOf(Full)
    vi.stubGlobal('fetch', answer({ detail: 'Cloud renderer unavailable; try again shortly' }))
    await expect(
      new CloudClient('https://gpu.example').frame(captured, still(), signal),
    ).rejects.toBeInstanceOf(Busy)
  })
})

/** Reads an FRG1 blob back the way render-server/fury_render/protocol.py does. */
function parseGeometry(blob: Uint8Array) {
  const view = new DataView(blob.buffer, blob.byteOffset, blob.byteLength)
  expect(new TextDecoder().decode(blob.subarray(0, 4))).toBe('FRG1')
  const length = view.getUint32(4, true)
  expect(length % 4).toBe(0)
  const header = JSON.parse(new TextDecoder().decode(blob.subarray(8, 8 + length)))
  const base = blob.byteOffset + 8 + length
  const floats = (offset: number, size: number) =>
    Array.from(
      new Float32Array(blob.buffer.slice(base + offset, base + offset + header.count * size * 4)),
    )
  return {
    header,
    position: floats(header.position, 3),
    normal: header.normal === null ? null : floats(header.normal, 3),
    uv: header.uv === null ? null : floats(header.uv, 2),
    index: header.index
      ? Array.from(
          new Uint32Array(
            blob.buffer.slice(
              base + header.index.offset,
              base + header.index.offset + header.index.count * 4,
            ),
          ),
        )
      : null,
  }
}

describe('geometry blobs', () => {
  it('carry positions, normals, uvs, indices, and groups', () => {
    const box = new BoxGeometry(1, 2, 3)
    const parsed = parseGeometry(encodeGeometry(box))
    expect(parsed.header.count).toBe(box.getAttribute('position').count)
    expect(parsed.position).toEqual(Array.from(box.getAttribute('position').array))
    expect(parsed.normal).toEqual(Array.from(box.getAttribute('normal').array))
    expect(parsed.uv).toEqual(Array.from(box.getAttribute('uv').array))
    expect(parsed.index).toEqual(Array.from(box.getIndex()!.array))
    expect(parsed.header.groups).toEqual(box.groups.map((g) => [g.start, g.count, g.materialIndex]))
  })

  it('clamp open-ended groups and widen 16-bit indices', () => {
    const g = new BufferGeometry()
    g.setAttribute('position', new BufferAttribute(new Float32Array(9), 3))
    g.setIndex(new BufferAttribute(new Uint16Array([0, 1, 2]), 1))
    g.addGroup(0, Infinity, 0)
    const parsed = parseGeometry(encodeGeometry(g))
    expect(parsed.header.groups).toEqual([[0, 3, 0]])
    expect(parsed.index).toEqual([0, 1, 2])
    expect(parsed.normal).toBeNull()
    expect(parsed.uv).toBeNull()
  })

  it('unpack interleaved attributes', () => {
    const g = new BufferGeometry()
    const buffer = new InterleavedBuffer(new Float32Array([1, 2, 3, 9, 4, 5, 6, 9, 7, 8, 9, 9]), 4)
    g.setAttribute('position', new InterleavedBufferAttribute(buffer, 3, 0))
    expect(parseGeometry(encodeGeometry(g)).position).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9])
  })
})

describe('instance and sky blobs', () => {
  it('copy only the drawn instances', () => {
    const matrices = new Float32Array(48).map((_, i) => i)
    const blob = encodeInstances(matrices, 2)
    const view = new DataView(blob.buffer)
    expect(new TextDecoder().decode(blob.subarray(0, 4))).toBe('FRI1')
    expect(view.getUint32(4, true)).toBe(2)
    expect(Array.from(new Float32Array(blob.buffer, 8))).toEqual(
      Array.from(matrices.subarray(0, 32)),
    )
  })

  it('store the sky as half-float RGB in texture order', () => {
    const data = new Float32Array([0.5, 1, 2, 1, 4, 8, 16, 1])
    const blob = encodeSky(data, 2, 1)
    const view = new DataView(blob.buffer)
    expect(view.getUint32(4, true)).toBe(2)
    expect(view.getUint32(8, true)).toBe(1)
    const half = Array.from(new Uint16Array(blob.buffer, 12, 6)).map(DataUtils.fromHalfFloat)
    expect(half).toEqual([0.5, 1, 2, 4, 8, 16])
  })
})

describe('server address', () => {
  afterEach(() => vi.unstubAllEnvs())

  it('comes from the build and can be switched off', () => {
    vi.stubEnv('VITE_CLOUD_RENDER_URL', 'https://example.modal.run/')
    expect(cloudUrl('')).toBe('https://example.modal.run')
    expect(cloudUrl('?cloud=0')).toBeNull()
  })

  it('may point at a local server, but nowhere else, from the address bar', () => {
    vi.stubEnv('VITE_CLOUD_RENDER_URL', '')
    expect(cloudUrl('')).toBeNull()
    expect(cloudUrl('?cloud=http://127.0.0.1:8787')).toBe('http://127.0.0.1:8787')
    expect(cloudUrl('?cloud=https://elsewhere.example')).toBeNull()
  })
})

// @vitest-environment jsdom
import {
  BoxGeometry,
  BufferAttribute,
  BufferGeometry,
  DataUtils,
  InterleavedBuffer,
  InterleavedBufferAttribute,
  PerspectiveCamera,
} from 'three/webgpu'
import { gzipSync } from 'node:zlib'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  cameraRecord,
  CLOUD_QUALITY,
  CloudClient,
  cloudUrl,
  decodeFrame,
  encodeGeometry,
  encodeInstances,
  encodeSky,
  PREVIEW_QUALITY,
  unpackImage,
} from './cloud'

describe('cloud requests', () => {
  const camera = { matrix: Array(16).fill(0), fov: 34, near: 0.1, far: 2000 }
  const image = (status = 200) =>
    new Response(new Uint8Array(16), {
      status,
      headers: { 'x-image-width': '1', 'x-image-height': '1' },
    })
  afterEach(() => vi.unstubAllGlobals())

  it('ask for a quick preview on a session of its own, ahead of the full view', async () => {
    const fetch = vi.fn().mockImplementation(() => Promise.resolve(image()))
    vi.stubGlobal('fetch', fetch)
    const client = new CloudClient('https://gpu.example')
    const captured = { scene: {} as never, blobs: new Map() }
    const signal = new AbortController().signal
    await client.render(captured, camera, 100, 80, signal, 'preview')
    await client.render(captured, camera, 100, 80, signal)
    const [preview, view] = fetch.mock.calls.map((call) =>
      JSON.parse(new TextDecoder().decode(call[1].body as Uint8Array)),
    )
    expect(preview.kind).toBe('preview')
    expect(preview.quality).toEqual(PREVIEW_QUALITY)
    expect(view.kind).toBe('view')
    expect(view.quality).toEqual(CLOUD_QUALITY)
    expect(preview.session).toBe(`${view.session}p`)
  })

  it('upload each missing blob once when a preview and its view both need it', async () => {
    const puts: string[] = []
    let rendered = 0
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation(async (url: string, init: RequestInit) => {
        if (init.method === 'PUT') {
          puts.push(url)
          await new Promise((resolve) => setTimeout(resolve, 5))
          return new Response(null, { status: 204 })
        }
        // The server lacks both blobs until they are uploaded.
        if (puts.length < 2 && rendered++ < 2)
          return new Response(JSON.stringify({ missing: ['a'.repeat(64), 'b'.repeat(64)] }), {
            status: 409,
          })
        return image()
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
      client.render(captured, camera, 100, 80, signal, 'preview'),
      client.render(captured, camera, 100, 80, signal),
    ])
    expect(puts.sort()).toEqual([
      `https://gpu.example/blobs/${'a'.repeat(64)}`,
      `https://gpu.example/blobs/${'b'.repeat(64)}`,
    ])
  })
})

describe('cloud warmth', () => {
  it('does not treat a new client as a warm GPU', () => {
    const client = new CloudClient('https://gpu.example')
    expect(client.warm).toBe(false)
    client.lastSuccess = performance.now()
    expect(client.warm).toBe(true)
    client.lastSuccess = performance.now() - 5 * 60 * 1000
    expect(client.warm).toBe(false)
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

describe('rendered images', () => {
  it('decode the server packing exactly', () => {
    // pack_image() of a 3x2 image, inflated (render-server/fury_render/protocol.py).
    const packed = Uint8Array.from(
      atob('ADg8PED89AAW4BMAPj4+PPzCPQD0MrgAAAAAAAAAAABAGQAAAAAAAAAA7wBmZt4A'),
      (c) => c.charCodeAt(0),
    )
    const values = Array.from(unpackImage(packed, 3, 2)).map(DataUtils.fromHalfFloat)
    const expected = [
      [0, 0.5, 1, 1],
      [2, 0.25, 0.125, 1],
      [100, 0.001, 3.5, 1],
      [1.5, 1.5, 1.5, 1],
      [0.75, 0, 65000, 1],
      [0.1, 0.2, 0.3, 1],
    ].flat()
    values.forEach((v, i) =>
      expect(v).toBeCloseTo(expected[i], Math.abs(expected[i]) > 10 ? -2 : 3),
    )
  })

  it('reject truncated data', () => {
    expect(() => unpackImage(new Uint8Array(10), 3, 2)).toThrow()
  })

  it('decode from the gzip file kept in the view cache, or already inflated', async () => {
    const packed = Uint8Array.from(
      atob('ADg8PED89AAW4BMAPj4+PPzCPQD0MrgAAAAAAAAAAABAGQAAAAAAAAAA7wBmZt4A'),
      (c) => c.charCodeAt(0),
    )
    const expected = Array.from(unpackImage(packed, 3, 2))
    const stats = { queueMs: 0, prepareMs: 0, renderMs: 0, totalMs: 0, device: '', denoise: '' }
    for (const bytes of [new Uint8Array(gzipSync(packed)), packed]) {
      const texture = await decodeFrame({ bytes, width: 3, height: 2, stats })
      expect(Array.from(texture.image.data as Uint16Array)).toEqual(expected)
      expect([texture.image.width, texture.image.height]).toEqual([3, 2])
    }
  })
})

describe('camera', () => {
  it('narrows the field of view with zoom', () => {
    const camera = new PerspectiveCamera(60, 1.5, 0.1, 500)
    camera.zoom = 2
    camera.position.set(1, 2, 3)
    camera.updateMatrixWorld()
    const record = cameraRecord(camera)
    expect(record.fov).toBeCloseTo((2 * Math.atan(Math.tan(Math.PI / 6) / 2) * 180) / Math.PI)
    expect(record.matrix.slice(12, 15)).toEqual([1, 2, 3])
    expect([record.near, record.far]).toEqual([0.1, 500])
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

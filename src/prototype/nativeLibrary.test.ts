// @vitest-environment jsdom
import { webcrypto } from 'node:crypto'
import { afterEach, expect, it, vi } from 'vitest'
import { defaultDesign, designEnvelopeSchema, parseDesign } from '../domain/design'
import {
  bytesSha256,
  decodeNativeImage,
  findNativeImage,
  type NativeEntry,
  type NativeLibrary,
} from './nativeLibrary'

const design = parseDesign({
  ...defaultDesign(),
  presentation: { ...defaultDesign().presentation, lookRef: 'studio-day-draft@1' },
})
const entry: NativeEntry = {
  id: 'design-01-1',
  configId: 'design-01',
  design: designEnvelopeSchema.parse(design),
  requestKey: 'a'.repeat(64),
  imageSha256: 'b'.repeat(64),
  recipeDigest: 'c'.repeat(64),
  manifestSha256: 'd'.repeat(64),
  workerSha256: 'e'.repeat(64),
  imageBytes: 1000,
  width: 1920,
  height: 1200,
  samples: 1024,
  renderSeconds: 28,
  productionAllowed: false,
  visuallyQualified: false,
  strictReference: false,
}
const library: NativeLibrary = {
  version: 1,
  revision: 'f'.repeat(64),
  renderer: 'Blender 4.5.0 / Cycles OptiX / NVIDIA L40S',
  entries: [entry],
}
afterEach(() => vi.unstubAllGlobals())
function webpBytes() {
  const bytes = new Uint8Array(1000)
  bytes.set(new TextEncoder().encode('RIFF'), 0)
  bytes.set(new TextEncoder().encode('WEBP'), 8)
  return bytes
}

it('matches the full configuration, view, lighting and aspect instead of reusing a finish image', () => {
  expect(findNativeImage(library, design)).toBe(entry)
  for (const patch of [
    { cameraRef: 'front-draft@1' },
    { lookRef: 'studio-night-draft@1' },
    { lookRef: 'courtyard-day-draft@1' },
    { aspect: 'tall' },
    { doorPose: 'open' },
  ]) {
    expect(
      findNativeImage(
        library,
        parseDesign({ ...design, presentation: { ...design.presentation, ...patch } }),
      ),
    ).toBeUndefined()
  }
  expect(
    findNativeImage(
      library,
      parseDesign({
        ...design,
        config: { ...design.config, appearance: { ...design.config.appearance, floor: 'oak' } },
      }),
    ),
  ).toBeUndefined()
})

it('rejects corrupt image bytes without constructing a display URL', async () => {
  vi.stubGlobal('crypto', webcrypto)
  vi.stubGlobal(
    'fetch',
    vi
      .fn()
      .mockResolvedValue(new Response(webpBytes(), { headers: { 'content-type': 'image/webp' } })),
  )
  await expect(decodeNativeImage(entry, new AbortController().signal)).rejects.toThrow(
    'verification failed',
  )
})

it('decodes a verified image once and reuses its exact cached bytes', async () => {
  vi.stubGlobal('crypto', webcrypto)
  const data = webpBytes()
  const valid = { ...entry, imageSha256: await bytesSha256(data) }
  const fetch = vi
    .fn()
    .mockResolvedValue(new Response(data, { headers: { 'content-type': 'image/webp' } }))
  vi.stubGlobal('fetch', fetch)
  vi.stubGlobal('URL', {
    createObjectURL: () => 'blob:verified-test-image',
    revokeObjectURL: vi.fn(),
  })
  vi.stubGlobal(
    'Image',
    class {
      src = ''
      naturalWidth = 1920
      naturalHeight = 1200
      decode() {
        return Promise.resolve()
      }
    },
  )
  const first = await decodeNativeImage(valid, new AbortController().signal)
  expect(first.src).toBe('blob:verified-test-image')
  const second = await decodeNativeImage(valid, new AbortController().signal)
  expect(second.src).toBe('blob:verified-test-image')
  expect(fetch).toHaveBeenCalledTimes(1)
  first.release()
  expect(URL.revokeObjectURL).not.toHaveBeenCalled()
  second.release()
  expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:verified-test-image')
})

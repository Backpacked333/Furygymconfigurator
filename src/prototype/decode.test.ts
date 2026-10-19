// @vitest-environment jsdom
import { webcrypto } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { defaultDesign } from '../domain/design'
import { createMockArtifact, type MockArtifact } from '../image-service/protocol'
import { decodeMockImage } from './imageClient'

let artifact: MockArtifact
beforeEach(async () => {
  vi.stubGlobal('crypto', webcrypto)
  artifact = await createMockArtifact(defaultDesign())
})
afterEach(() => vi.unstubAllGlobals())

describe('decode boundary before mock publication', () => {
  it('verifies complete intrinsic dimensions, not just a resolved decode call', async () => {
    vi.stubGlobal(
      'Image',
      class {
        src = ''
        naturalWidth = 1
        naturalHeight = 1
        decode() {
          return Promise.resolve()
        }
      },
    )
    await expect(decodeMockImage(artifact, new AbortController().signal)).rejects.toThrow(
      'dimensions',
    )
  })
  it('rejects decoding errors without substituting an image', async () => {
    vi.stubGlobal(
      'Image',
      class {
        src = ''
        decode() {
          return Promise.reject(new Error('Broken'))
        }
      },
    )
    await expect(decodeMockImage(artifact, new AbortController().signal)).rejects.toThrow(
      'decoding failed',
    )
  })
  it('aborts a hanging decode on selection change/unmount', async () => {
    vi.stubGlobal(
      'Image',
      class {
        src = ''
        decode() {
          return new Promise<void>(() => undefined)
        }
      },
    )
    const controller = new AbortController()
    const promise = decodeMockImage(artifact, controller.signal)
    const rejected = expect(promise).rejects.toThrow('cancelled')
    controller.abort()
    await rejected
  })
  it('does not start decoding after cancellation', async () => {
    const decode = vi.fn().mockResolvedValue(undefined)
    vi.stubGlobal(
      'Image',
      class {
        src = ''
        decode = decode
      },
    )
    const controller = new AbortController()
    controller.abort()
    await expect(decodeMockImage(artifact, controller.signal)).rejects.toThrow('cancelled')
    expect(decode).not.toHaveBeenCalled()
  })
  it('attaches load listeners before src for cached-image fallback without decode()', async () => {
    vi.stubGlobal(
      'Image',
      class {
        onload: (() => void) | null = null
        naturalWidth = artifact.width
        naturalHeight = artifact.height
        set src(_value: string) {
          this.onload?.()
        }
      },
    )
    await expect(decodeMockImage(artifact, new AbortController().signal)).resolves.toBeUndefined()
  })
})

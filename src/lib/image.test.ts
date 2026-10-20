// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { pngOf } from './image'

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('exporting a finished image without WebGPU', () => {
  it('rejects an unsuccessful asset response', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false }))
    await expect(pngOf('/missing.webp')).rejects.toThrow('could not be downloaded')
  })
  it('converts to PNG and closes the bitmap even if the browser cannot export', async () => {
    const bitmap = { width: 2400, height: 1500, close: vi.fn() }
    vi.stubGlobal('createImageBitmap', vi.fn().mockResolvedValue(bitmap))
    const drawImage = vi.fn()
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({ drawImage } as never)
    const output = vi
      .spyOn(HTMLCanvasElement.prototype, 'toDataURL')
      .mockReturnValue('data:image/png;base64,abc')
    expect(await pngOf(new Blob())).toBe('data:image/png;base64,abc')
    expect(drawImage).toHaveBeenCalledWith(bitmap, 0, 0)
    expect(output).toHaveBeenCalledWith('image/png')
    expect(bitmap.close).toHaveBeenCalledTimes(1)
    output.mockImplementation(() => {
      throw new Error('cannot export')
    })
    await expect(pngOf(new Blob())).rejects.toThrow('cannot export')
    expect(bitmap.close).toHaveBeenCalledTimes(2)
  })
})

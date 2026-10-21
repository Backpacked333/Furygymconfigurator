import { afterEach, describe, expect, it, vi } from 'vitest'
import { defaultDesign } from '../domain/design'
import { prefetchLiveView } from './liveIntent'

const scene = vi.hoisted(() => vi.fn())
const warmLiveDesign = vi.hoisted(() => vi.fn())
vi.mock('./LiveDesignScene', () => {
  scene()
  return { default: () => null }
})
vi.mock('./liveWarmup', () => ({ warmLiveDesign }))
afterEach(() => warmLiveDesign.mockClear())

describe('intent to open the 360° view', () => {
  it('loads the view, and starts the shown design’s scans downloading', async () => {
    const design = defaultDesign()
    prefetchLiveView(design)
    await vi.waitFor(() => expect(warmLiveDesign).toHaveBeenCalledWith(design))
    expect(scene).toHaveBeenCalled()
  })

  it('loads the view alone when no design is given', async () => {
    prefetchLiveView()
    await new Promise((resolve) => setTimeout(resolve))
    expect(warmLiveDesign).not.toHaveBeenCalled()
  })

  it('never fails the page when the early download cannot start', async () => {
    warmLiveDesign.mockImplementationOnce(() => {
      throw new Error('Invalid design')
    })
    const unhandled = vi.fn()
    process.on('unhandledRejection', unhandled)
    try {
      prefetchLiveView({})
      await vi.waitFor(() => expect(warmLiveDesign).toHaveBeenCalled())
      await new Promise((resolve) => setTimeout(resolve))
      expect(unhandled).not.toHaveBeenCalled()
    } finally {
      process.off('unhandledRejection', unhandled)
    }
  })
})

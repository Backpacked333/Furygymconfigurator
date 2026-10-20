// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import { defaultDesign, type DesignEnvelope } from '../domain/design'
import { useNativeLibraryImage } from './useNativeLibraryImage'

const calls = vi.hoisted(() => ({
  decode: vi.fn(),
  find: vi.fn(),
  library: vi.fn(),
  dynamic: vi.fn(),
}))
vi.mock('./useLibrarySet', () => ({ useLibrarySet: () => calls.library() ?? { snapshot: null } }))
vi.mock('./renderLibraryClient', () => ({ decodeLibraryImage: calls.dynamic }))
vi.mock('./nativeLibrary', () => ({
  getNativeLibrary: async () => ({}),
  findNativeImage: (_library: unknown, design: DesignEnvelope) =>
    calls.find.getMockImplementation() ? calls.find(design) : { design },
  decodeNativeImage: calls.decode,
}))
afterEach(() => {
  vi.unstubAllGlobals()
  calls.decode.mockReset()
  calls.find.mockReset()
  calls.library.mockReset()
  calls.dynamic.mockReset()
  vi.useRealTimers()
})

function harness() {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  const root = createRoot(document.createElement('div'))
  let latest!: ReturnType<typeof useNativeLibraryImage>
  function Probe({ design }: { design: DesignEnvelope }) {
    latest = useNativeLibraryImage(design)
    return null
  }
  return {
    get image() {
      return latest
    },
    render: async (design: DesignEnvelope) =>
      act(async () => root.render(<Probe design={design} />)),
    close: () => act(() => root.unmount()),
  }
}

it('retains the previous lease while loading and crossfading, then releases it once', async () => {
  vi.useFakeTimers()
  const a = defaultDesign(),
    b = defaultDesign({ family: 'container', lengthFt: 40 })
  const oldRelease = vi.fn(),
    newRelease = vi.fn()
  calls.decode.mockResolvedValueOnce({ src: 'blob:a', release: oldRelease })
  let ready!: (value: unknown) => void
  calls.decode.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        ready = resolve
      }),
  )
  const h = harness()
  try {
    await h.render(a)
    await h.render(b)
    expect(h.image.current).toBe(false)
    expect(h.image.shown?.src).toBe('blob:a')
    expect(oldRelease).not.toHaveBeenCalled()
    await act(async () => ready({ src: 'blob:b', release: newRelease }))
    expect(h.image.current).toBe(true)
    expect(h.image.shown?.src).toBe('blob:b')
    expect(h.image.previous?.src).toBe('blob:a')
    expect(oldRelease).not.toHaveBeenCalled()
    act(() => h.image.finishTransition('blob:b'))
    expect(h.image.previous).toBeNull()
    expect(oldRelease).toHaveBeenCalledTimes(1)
    act(() => vi.advanceTimersByTime(1000))
    expect(oldRelease).toHaveBeenCalledTimes(1)
  } finally {
    h.close()
  }
  expect(newRelease).toHaveBeenCalledTimes(1)
})

it.each(['missing', 'error'])(
  'clears the previous image for a confirmed %s instead of substituting it',
  async (state) => {
    const release = vi.fn()
    calls.decode.mockResolvedValueOnce({ src: 'blob:a', release })
    const h = harness()
    try {
      await h.render(defaultDesign())
      if (state === 'missing') calls.find.mockReturnValue(undefined)
      else calls.decode.mockRejectedValueOnce(new Error('decode'))
      await h.render(defaultDesign({ family: 'container', lengthFt: 40 }))
      expect(h.image.shown).toBeNull()
      expect(h.image.previous).toBeNull()
      expect(h.image.current).toBe(false)
      expect(release).toHaveBeenCalledTimes(1)
    } finally {
      h.close()
    }
  },
)

it('waits for a dynamic lookup before treating a static catalog miss as missing', async () => {
  calls.decode.mockResolvedValueOnce({ src: 'blob:a', release: vi.fn() })
  const h = harness(),
    b = defaultDesign({ family: 'container', lengthFt: 40 })
  try {
    await h.render(defaultDesign())
    calls.find.mockReturnValue(undefined)
    calls.library.mockReturnValue({ snapshot: null, checking: true })
    await h.render(b)
    expect(h.image.progress.state).toBe('pending')
    expect(h.image.shown?.src).toBe('blob:a')
    calls.library.mockReturnValue({
      snapshot: {
        views: [
          { cameraRef: b.presentation.cameraRef, status: 'ready', image: { sha256: 'verified' } },
        ],
      },
      checking: false,
    })
    calls.dynamic.mockResolvedValueOnce({ src: 'blob:b', release: vi.fn() })
    await h.render(b)
    expect(h.image.current).toBe(true)
    expect(h.image.previous?.src).toBe('blob:a')
  } finally {
    h.close()
  }
})

it('finishes the visible fade before blending the latest decoded selection', async () => {
  vi.useFakeTimers()
  const releases = [vi.fn(), vi.fn(), vi.fn()]
  for (let i = 0; i < 3; i++)
    calls.decode.mockResolvedValueOnce({ src: `blob:${i}`, release: releases[i] })
  const h = harness()
  try {
    await h.render(defaultDesign())
    await h.render(defaultDesign({ family: 'container', lengthFt: 20 }))
    await h.render(defaultDesign({ family: 'container', lengthFt: 40 }))
    expect(h.image.shown?.src).toBe('blob:1')
    expect(h.image.previous?.src).toBe('blob:0')
    expect(h.image.current).toBe(false)
    expect(releases[0]).not.toHaveBeenCalled()
    expect(releases[1]).not.toHaveBeenCalled()
    act(() => h.image.finishTransition('blob:1'))
    expect(releases[0]).toHaveBeenCalledTimes(1)
    expect(h.image.shown?.src).toBe('blob:2')
    expect(h.image.current).toBe(true)
    expect(h.image.previous?.src).toBe('blob:1')
    act(() => h.image.finishTransition('blob:1'))
    expect(h.image.previous?.src).toBe('blob:1')
    act(() => vi.advanceTimersByTime(800))
    expect(h.image.previous).toBeNull()
    expect(releases[1]).toHaveBeenCalledTimes(1)
  } finally {
    h.close()
  }
  expect(releases[2]).toHaveBeenCalledTimes(1)
})

it('skips the crossfade for reduced motion and does not hold a redundant lease', async () => {
  vi.stubGlobal('matchMedia', () => ({ matches: true }))
  const release = vi.fn()
  calls.decode
    .mockResolvedValueOnce({ src: 'blob:a', release })
    .mockResolvedValueOnce({ src: 'blob:b', release: vi.fn() })
  const h = harness()
  try {
    await h.render(defaultDesign())
    await h.render(defaultDesign({ family: 'container', lengthFt: 40 }))
    expect(h.image.previous).toBeNull()
    expect(h.image.current).toBe(true)
    expect(release).toHaveBeenCalledTimes(1)
  } finally {
    h.close()
  }
})

it('does not cut a cached-image fade short when the background set lookup finishes', async () => {
  vi.useFakeTimers()
  calls.library.mockReturnValue({ checking: true, snapshot: null })
  calls.find.mockImplementation((design: DesignEnvelope) => ({ design, imageSha256: 'verified' }))
  const release = vi.fn()
  calls.decode
    .mockResolvedValueOnce({ src: 'blob:a', release })
    .mockResolvedValueOnce({ src: 'blob:b', release: vi.fn() })
  const h = harness(),
    b = defaultDesign({ family: 'container', lengthFt: 40 })
  try {
    await h.render(defaultDesign())
    await h.render(b)
    expect(h.image.previous?.src).toBe('blob:a')
    calls.library.mockReturnValue({
      checking: false,
      snapshot: {
        views: [
          { cameraRef: b.presentation.cameraRef, status: 'ready', image: { sha256: 'verified' } },
        ],
      },
    })
    await h.render(b)
    expect(h.image.previous?.src).toBe('blob:a')
    expect(h.image.current).toBe(true)
    expect(calls.decode).toHaveBeenCalledTimes(2)
    expect(calls.dynamic).not.toHaveBeenCalled()
    expect(release).not.toHaveBeenCalled()
    act(() => vi.advanceTimersByTime(800))
    expect(release).toHaveBeenCalledTimes(1)
  } finally {
    h.close()
  }
})

it('keeps a running blend intact while loading and discards superseded queued images', async () => {
  vi.useFakeTimers()
  const releases = Array.from({ length: 4 }, () => vi.fn())
  for (let i = 0; i < 4; i++)
    calls.decode.mockResolvedValueOnce({ src: `blob:${i}`, release: releases[i] })
  const h = harness()
  try {
    await h.render(defaultDesign())
    await h.render(defaultDesign({ family: 'container', lengthFt: 20 }))
    await h.render(defaultDesign({ family: 'container', lengthFt: 40 }))
    await h.render(defaultDesign({ family: 'studio', lengthFt: 40 }))
    expect(h.image.shown?.src).toBe('blob:1')
    expect(h.image.previous?.src).toBe('blob:0')
    expect(releases[2]).toHaveBeenCalledTimes(1)
    act(() => vi.advanceTimersByTime(700))
    expect(releases[0]).not.toHaveBeenCalled()
    act(() => h.image.finishTransition('blob:1'))
    expect(h.image.shown?.src).toBe('blob:3')
    expect(h.image.previous?.src).toBe('blob:1')
  } finally {
    h.close()
  }
  for (const release of releases) expect(release).toHaveBeenCalledTimes(1)
})

it('shows the assembly state rather than a substitute image while a new view is GPU rendering', async () => {
  const release = vi.fn()
  calls.decode.mockResolvedValueOnce({ src: 'blob:a', release })
  const h = harness(),
    b = defaultDesign({ family: 'container', lengthFt: 40 })
  try {
    await h.render(defaultDesign())
    calls.find.mockReturnValue(undefined)
    calls.library.mockReturnValue({
      checking: false,
      snapshot: {
        job: { stage: 'rendering' },
        views: [{ cameraRef: b.presentation.cameraRef, status: 'pending' }],
      },
    })
    await h.render(b)
    expect(h.image.shown).toBeNull()
    expect(h.image.current).toBe(false)
    expect(h.image.library.snapshot?.job?.stage).toBe('rendering')
    expect(release).toHaveBeenCalledTimes(1)
  } finally {
    h.close()
  }
})
it('does not reload a verified image when an equivalent design object is reconstructed', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  const release = vi.fn()
  calls.decode.mockResolvedValue({ src: 'blob:stable', release })
  const root = createRoot(document.createElement('div'))
  function Probe() {
    useNativeLibraryImage(defaultDesign())
    return null
  }
  try {
    await act(async () => root.render(<Probe />))
    await act(async () => root.render(<Probe />))
    expect(calls.decode).toHaveBeenCalledTimes(1)
    expect(release).not.toHaveBeenCalled()
  } finally {
    act(() => root.unmount())
  }
  expect(release).toHaveBeenCalledTimes(1)
})
it('fences obsolete A→B→A completions, including a decoder that ignores abort', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  const pending: ((value: { src: string }) => void)[] = []
  calls.decode.mockImplementation(() => new Promise((resolve) => pending.push(resolve)))
  const host = document.createElement('div')
  const root = createRoot(host)
  let latest!: ReturnType<typeof useNativeLibraryImage>
  function Probe({ design }: { design: DesignEnvelope }) {
    latest = useNativeLibraryImage(design)
    return null
  }
  const a = defaultDesign(),
    b = defaultDesign({ family: 'container', lengthFt: 40 })
  try {
    for (const design of [a, b, a]) await act(async () => root.render(<Probe design={design} />))
    expect(pending).toHaveLength(3)
    await act(async () => pending[0]({ src: 'blob:obsolete-a' }))
    await act(async () => pending[1]({ src: 'blob:obsolete-b' }))
    expect(latest.current).toBe(false)
    await act(async () => pending[2]({ src: 'blob:current-a' }))
    expect(latest.current).toBe(true)
    expect(latest.shown?.src).toBe('blob:current-a')
  } finally {
    act(() => root.unmount())
  }
})

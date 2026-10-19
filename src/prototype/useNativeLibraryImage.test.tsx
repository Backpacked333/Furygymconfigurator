// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import { defaultDesign, type DesignEnvelope } from '../domain/design'
import { useNativeLibraryImage } from './useNativeLibraryImage'

const calls = vi.hoisted(() => ({ decode: vi.fn() }))
vi.mock('./useLibrarySet', () => ({ useLibrarySet: () => ({ snapshot: null }) }))
vi.mock('./nativeLibrary', () => ({
  getNativeLibrary: async () => ({}),
  findNativeImage: (_library: unknown, design: DesignEnvelope) => ({ design }),
  decodeNativeImage: calls.decode,
}))
afterEach(() => {
  vi.unstubAllGlobals()
  calls.decode.mockReset()
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

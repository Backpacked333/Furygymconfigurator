// @vitest-environment jsdom
import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { defaultDesign } from '../domain/design'
import { resolveNativeCamera } from '../render/nativeCamera'
import LiveDesignScene from './LiveDesignScene'

const seen = vi.hoisted(() => ({
  renderer: null as Record<string, unknown> | null,
  watch: null as Record<string, unknown> | null,
}))
vi.mock('../render/pathtrace', () => ({ loadTracerModule: async () => undefined }))
// The canvas is out of reach in jsdom: the surface renders only the scene's effects.
vi.mock('../components/SceneSurface', () => ({
  SceneSurface: ({ effects }: { effects: ReactNode }) => <>{effects}</>,
}))
vi.mock('../viewer/ProgressiveRenderer', () => ({
  ProgressiveRenderer: (props: Record<string, unknown>) => {
    seen.renderer = props
    return null
  },
}))
vi.mock('../viewer/EntryWatch', () => ({
  EntryWatch: (props: Record<string, unknown>) => {
    seen.watch = props
    return null
  },
}))

let root: Root
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  seen.renderer = seen.watch = null
  root = createRoot(document.createElement('div'))
})
afterEach(() => {
  act(() => root.unmount())
  vi.unstubAllGlobals()
})

it('watches the camera leave the saved image’s own pose beside the progressive renderer', () => {
  const design = defaultDesign()
  const onLeaveEntry = vi.fn()
  const props = {
    design,
    active: true,
    unit: 'ft' as const,
    dimensions: false,
    autoRotate: false,
    reset: 0,
    onReady: vi.fn(),
    onStatus: vi.fn(),
    onUnavailable: vi.fn(),
  }
  act(() => root.render(<LiveDesignScene {...props} onLeaveEntry={onLeaveEntry} />))
  expect(seen.watch).toEqual({
    active: true,
    pose: resolveNativeCamera(design),
    onLeave: onLeaveEntry,
  })
  expect(Object.keys(seen.renderer!).sort()).toEqual(
    ['active', 'look', 'onReady', 'onStatus', 'place', 'quality', 'revision'].sort(),
  )
  act(() => root.render(<LiveDesignScene {...props} active={false} />))
  expect(seen.watch).toMatchObject({ active: false, onLeave: undefined })
})

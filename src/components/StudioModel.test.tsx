// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_CONFIG } from '../lib/config'
import { MirrorWall } from './StudioModel'

describe('the mirror wall', () => {
  let quiet: ReturnType<typeof vi.spyOn>
  beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
    // The scene's elements are not HTML, which React DOM says of each: not the point here.
    quiet = vi.spyOn(console, 'error').mockImplementation(() => {})
  })
  afterEach(() => {
    quiet.mockRestore()
    vi.unstubAllGlobals()
  })

  it('mounts its frame and its glass together, once the glass exists: one edit, one design', () => {
    const container = document.createElement('div')
    const mounted = new MutationObserver(() => {})
    mounted.observe(container, { childList: true, subtree: true })
    const root = createRoot(container)
    act(() => root.render(<MirrorWall config={DEFAULT_CONFIG} quality="lite" />))
    // One insertion, of the wall whole: the spin's panorama then renders once for it, where a
    // frame mounted first and the glass a frame later (the glass is made in an effect) would
    // have it rendered twice.
    const insertions = mounted.takeRecords()
    expect(insertions).toHaveLength(1)
    expect(insertions[0].target).toBe(container)
    const wall = container.firstElementChild!
    expect(wall.tagName.toLowerCase()).toBe('group')
    expect([...wall.children].map((child) => child.tagName.toLowerCase())).toEqual(['mesh', 'mesh'])
    act(() => root.unmount())
    expect(container.children).toHaveLength(0)
    mounted.disconnect()
  })
})

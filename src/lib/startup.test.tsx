// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AppErrorBoundary } from '../components/AppErrorBoundary'
import { startApplication } from './startup'

describe('application startup and recovery', () => {
  let host: HTMLDivElement
  beforeEach(() => {
    host = document.createElement('div')
    document.body.append(host)
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  })
  afterEach(() => {
    host.remove()
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  it('announces loading until the selected entry mounts', async () => {
    let ready!: () => void
    const pending = startApplication(host, () => new Promise<void>((resolve) => (ready = resolve)))
    expect(host.getAttribute('aria-busy')).toBe('true')
    expect(host.querySelector('[role="status"]')?.textContent).toContain('Loading Fury')
    host.textContent = 'Mounted'
    ready()
    await pending
    expect(host.hasAttribute('aria-busy')).toBe(false)
    expect(host.textContent).toBe('Mounted')
  })

  it('contains entry failures without another entry, storage writes or fragment changes', async () => {
    const originalHash = window.location.hash
    const writes = vi.spyOn(Storage.prototype, 'setItem')
    const mount = vi.fn().mockRejectedValue(new Error('chunk unavailable'))
    await startApplication(host, mount)
    expect(mount).toHaveBeenCalledOnce()
    expect(host.querySelector('[role="alert"]')?.textContent).toContain('could not start')
    expect(host.querySelector('button')?.textContent).toBe('Reload')
    expect(host.hasAttribute('aria-busy')).toBe(false)
    expect(writes).not.toHaveBeenCalled()
    expect(window.location.hash).toBe(originalHash)
  })

  it('can report a prototype render failure without claiming unsaved edits were saved', () => {
    const root = createRoot(host)
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    function Broken(): never {
      throw new Error('render failure')
    }
    act(() => {
      root.render(
        <AppErrorBoundary recoveryMessage="Unsaved edits may be lost on reload.">
          <Broken />
        </AppErrorBoundary>,
      )
    })
    expect(error).toHaveBeenCalled()
    expect(host.querySelector('[role="alert"]')?.textContent).toContain('Unsaved edits')
    expect(host.textContent).not.toContain('Your design is saved')
    act(() => root.unmount())
  })
})

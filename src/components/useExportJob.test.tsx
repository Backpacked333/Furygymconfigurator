// @vitest-environment jsdom
import { act, StrictMode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_CONFIG } from '../lib/config'
import type { CaptureProvider, CaptureRequest, CaptureResult } from '../lib/capture'
import type { PresentationState } from '../lib/presentation'
import { useExportJob, type ExportContext } from './useExportJob'

describe('application export job ownership', () => {
  let root: Root, host: HTMLDivElement
  let context: ExportContext, provider: CaptureProvider, state: PresentationState
  let job: ReturnType<typeof useExportJob>
  let resolve: (result: CaptureResult) => void
  let request: CaptureRequest
  const download = vi.fn()
  function Harness({ context }: { context: ExportContext }) {
    job = useExportJob(context)
    return <span>{job.message}</span>
  }
  const render = async () => {
    await act(async () => {
      root.render(
        <StrictMode>
          <Harness context={context} />
        </StrictMode>,
      )
    })
  }
  const start = () => {
    let pending!: Promise<void>
    act(() => {
      pending = job.run(true, async (exportJob) => {
        const result = await exportJob.capture('current', { width: 960, height: 540 })
        exportJob.assertCurrent()
        download(exportJob.config, result)
      })
    })
    return pending
  }
  const complete = async (pending: Promise<void>) => {
    await act(async () => {
      resolve({
        status: 'ready',
        blob: new Blob(['test-double']),
        rendered: { width: 960, height: 540 },
        encoded: { width: 960, height: 540 },
        reasons: [],
        provenance: {
          token: { ...state.token },
          framing: 'current',
          mode: 'current',
          transform: 'AgX/sRGB',
          native: true,
        },
      })
      await pending
    })
  }
  beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
    download.mockReset()
    state = {
      stage: 'settled',
      animating: false,
      reasons: [],
      rendered: { width: 960, height: 540 },
      token: {
        revision: 7,
        generation: 2,
        camera: 'fixed',
        material: '2:19',
        presentation: 'day',
        view: 'exterior',
        quality: 'lite',
        preview: false,
      },
    }
    provider = {
      generation: 2,
      getState: () => state,
      subscribe: () => () => {},
      preflight: vi.fn(),
      capture: vi.fn((value: CaptureRequest) => {
        request = value
        return new Promise<CaptureResult>((done) => {
          resolve = done
        })
      }),
    }
    context = {
      config: structuredClone(DEFAULT_CONFIG),
      revision: 7,
      getProvider: () => provider,
      blocked: false,
    }
    host = document.createElement('div')
    document.body.append(host)
    root = createRoot(host)
  })
  afterEach(async () => {
    await act(async () => root.unmount())
    host.remove()
    vi.unstubAllGlobals()
  })
  it('freezes the document before asynchronous work and prevents duplicate jobs', async () => {
    await render()
    const pending = start()
    const duplicate = vi.fn()
    await act(async () => {
      await job.run(true, duplicate)
    })
    expect(duplicate).not.toHaveBeenCalled()
    expect(job.busy).toBe(true)
    context.config.time = 18
    await complete(pending)
    expect(download.mock.calls[0][0].time).toBe(DEFAULT_CONFIG.time)
    expect(provider.capture).toHaveBeenCalledOnce()
    expect(job.busy).toBe(false)
  })
  it('refuses preview or repair state before starting a capture', async () => {
    context = { ...context, blocked: true }
    await render()
    await act(async () => {
      await start()
    })
    expect(provider.capture).not.toHaveBeenCalled()
    expect(download).not.toHaveBeenCalled()
    expect(job.message).toContain('design changed')
  })
  it('aborts on a new revision and rejects late bytes even if the capture ignores abort', async () => {
    await render()
    const pending = start()
    context = { ...context, revision: 9 }
    await render()
    expect(request.signal?.aborted).toBe(true)
    await complete(pending)
    expect(download).not.toHaveBeenCalled()
    expect(job.busy).toBe(false)
  })
  it('rejects a replaced provider even if it reports the same generation and token', async () => {
    await render()
    const pending = start()
    provider = { ...provider }
    await complete(pending)
    expect(download).not.toHaveBeenCalled()
    expect(job.message).toContain('view changed')
  })
  it('cancels between PDF generation and download without needing a renderer', async () => {
    context = { ...context, getProvider: () => null }
    await render()
    let finish!: () => void, pending!: Promise<void>
    act(() => {
      pending = job.run(false, async (exportJob) => {
        await new Promise<void>((done) => {
          finish = done
        })
        exportJob.assertCurrent()
        download()
      })
    })
    act(() => job.cancel())
    await act(async () => {
      finish()
      await pending
    })
    expect(download).not.toHaveBeenCalled()
    expect(job.message).toContain('No file was downloaded')
  })
  it('permits image-free PDF work while graphics are unavailable', async () => {
    context = { ...context, getProvider: () => null }
    await render()
    await act(async () => {
      await job.run(false, async (exportJob) => {
        exportJob.assertCurrent()
        download(exportJob.config)
      })
    })
    expect(download).toHaveBeenCalledWith(DEFAULT_CONFIG)
    expect(provider.capture).not.toHaveBeenCalled()
  })
  it('aborts and rejects late bytes after its controls unmount', async () => {
    await render()
    const pending = start()
    await act(async () => root.render(null))
    expect(request.signal?.aborted).toBe(true)
    await complete(pending)
    expect(download).not.toHaveBeenCalled()
  })
})

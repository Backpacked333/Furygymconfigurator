// Explicit fake process and CDP pipe tests only; never launch or connect to any browser here.
import { EventEmitter } from 'node:events'
import type { ChildProcess, spawn } from 'node:child_process'
import { PassThrough } from 'node:stream'
import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { CAPTURE_LIMITS, CaptureContractError } from './contract'
import {
  CHROME_EXECUTABLE,
  WATCHDOG_EXECUTABLE,
  PipeCdp,
  classifyBrowserDiagnostic,
  launchOwnedBrowser,
  workerExpression,
  type CdpEvent,
  type CdpTransport,
} from './runner-browser'
const roots: string[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})
describe('bounded private CDP framing', () => {
  it('reduces browser diagnostics to a fixed vocabulary without retaining paths or URLs', () => {
    expect(
      classifyBrowserDiagnostic(
        'No usable sandbox! /private/example https://example.invalid/secret',
      ),
    ).toEqual(['sandbox-unavailable'])
    expect(classifyBrowserDiagnostic('GPU process exited; WebGL not supported')).toEqual([
      'gpu-process-failed',
      'webgl-unavailable',
    ])
    expect(classifyBrowserDiagnostic('Failed to create a ProcessSingleton at /private')).toEqual([
      'profile-socket-failed',
    ])
    expect(classifyBrowserDiagnostic('chrome_crashpad_handler: --database is required')).toEqual([
      'crashpad-startup-failed',
    ])
    expect(classifyBrowserDiagnostic('[fury-capture-failure:graphics-api-error]')).toEqual([
      'graphics-api-error',
    ])
    expect(classifyBrowserDiagnostic('[fury-capture-failure:https://secret.invalid]')).toEqual([])
    expect(classifyBrowserDiagnostic('[fury-capture-stage:architecture-checked]')).toEqual([
      'stage:architecture-checked',
    ])
    expect(classifyBrowserDiagnostic('[fury-capture-stage:https://secret.invalid]')).toEqual([])
    expect(classifyBrowserDiagnostic('[fury-capture-failure:site-field-invalid]')).toEqual([
      'site-field-invalid',
    ])
    expect(classifyBrowserDiagnostic('some unexpected private error')).toEqual([])
  })
  it('handles split frames and resolves only matching command IDs', async () => {
    const input = new PassThrough(),
      output = new PassThrough(),
      failed = vi.fn(),
      client = new PipeCdp(input, output, failed)
    const reply = client.send('Browser.getVersion'),
      sent = JSON.parse(input.read().toString().replace(/\0$/, '')) as { id: number }
    output.write('{"id":')
    output.write(`${sent.id},"result":{"product":"Fake/1"}}\0`)
    expect(await reply).toEqual({ product: 'Fake/1' })
    expect(failed).not.toHaveBeenCalled()
    client.close()
  })
  it('retains only an allowlisted failed CDP method, never its raw error', async () => {
    const input = new PassThrough(),
      output = new PassThrough(),
      diagnostic = vi.fn()
    const client = new PipeCdp(input, output, vi.fn(), diagnostic)
    const pending = client.send('Network.setBypassServiceWorker')
    const assertion = expect(pending).rejects.toThrow('Private browser command failed.')
    const sent = JSON.parse(input.read().toString().replace(/\0$/, '')) as { id: number }
    output.write(JSON.stringify({ id: sent.id, error: { message: 'private/secret/url' } }) + '\0')
    await assertion
    expect(diagnostic).toHaveBeenCalledWith('cdp-command-failed:Network.setBypassServiceWorker')
    client.close()
  })
  it('rejects malformed/oversized messages and all pending commands', async () => {
    for (const payload of [
      Buffer.from('garbage\0'),
      Buffer.alloc(
        4 * Math.ceil(CAPTURE_LIMITS.pngBytes / 3) + 2 * CAPTURE_LIMITS.metadataBytes + 1,
      ),
    ]) {
      const input = new PassThrough(),
        output = new PassThrough(),
        failed = vi.fn(),
        client = new PipeCdp(input, output, failed)
      const reply = client.send('Runtime.enable')
      const assertion = expect(reply).rejects.toThrow()
      output.write(payload)
      await assertion
      expect(failed).toHaveBeenCalledOnce()
      client.close()
    }
  })
  it('has fixed bridge expressions, never a generic operator evaluate endpoint', () => {
    expect(workerExpression('ready')).toBe('globalThis.__FURY_LOCAL_CAPTURE__.ready()')
    expect(workerExpression('dispose')).toBe('globalThis.__FURY_LOCAL_CAPTURE__.dispose()')
  })
})
class FakeTransport implements CdpTransport {
  calls: { method: string; params: Record<string, unknown>; sessionId?: string }[] = []
  listeners = new Set<(event: CdpEvent) => void>()
  closed = false
  async send(method: string, params: Record<string, unknown> = {}, sessionId?: string) {
    this.calls.push({ method, params, sessionId })
    if (method === 'Fetch.enable' && sessionId === 'worker-session')
      throw new Error('Synthetic Chromium dedicated worker: Fetch.enable is unavailable.')
    if (method === 'Browser.getVersion')
      return { product: 'Test/1', userAgent: 'Synthetic test only' }
    if (method === 'Target.createTarget') {
      queueMicrotask(() =>
        this.emit({
          method: 'Target.attachedToTarget',
          params: {
            sessionId: 'page-session',
            targetInfo: { type: 'page', url: 'about:blank', targetId: 'page-target' },
          },
        }),
      )
      return { targetId: 'page-target' }
    }
    return {}
  }
  emit(event: CdpEvent) {
    for (const listener of this.listeners) listener(event)
  }
  listen(listener: (event: CdpEvent) => void) {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }
  close() {
    this.closed = true
  }
}
async function fakeBrowser() {
  const root = await mkdtemp(join(tmpdir(), 'fury-browser-fake-test-'))
  roots.push(root)
  const controller = new AbortController(),
    transport = new FakeTransport(),
    failures: Error[] = []
  const child = Object.assign(new EventEmitter(), {
    pid: 424242,
    exitCode: null as number | null,
    signalCode: null as string | null,
    stderr: new PassThrough(),
    stdio: [null, null, null, new PassThrough(), new PassThrough()],
  })
  const spawned = vi.fn(() => child as unknown as ChildProcess)
  const kill = vi.spyOn(process, 'kill').mockImplementation(() => {
    child.exitCode = 0
    child.emit('exit', 0, 'SIGKILL')
    return true
  })
  const host = {
    origin: 'http://127.0.0.1:9',
    pageUrl: 'http://127.0.0.1:9/private.html?renderer=webgl2',
    allow: (url: string, method: string, redirected = false) =>
      !redirected &&
      method === 'GET' &&
      [
        'http://127.0.0.1:9/private.html?renderer=webgl2',
        'http://127.0.0.1:9/assets/site.js',
      ].includes(url),
    assertHealthy: () => {},
    close: async () => {},
    stats: () => ({ requests: 0, bytes: 0, denied: 0 }),
  }
  const browser = await launchOwnedBrowser(
    {
      stateDirectory: root,
      host,
      signal: controller.signal,
      fence: () => {
        if (controller.signal.aborted)
          throw new CaptureContractError('cancelled', 'Synthetic abort')
      },
      onFailure: (error) => failures.push(error),
    },
    {
      spawn: spawned as unknown as typeof spawn,
      transport: () => transport,
      access: async () => {},
      realpath: async (path) => String(path),
      socketRoot: root,
    },
  )
  return { root, browser, transport, controller, failures, spawned, kill }
}
describe('owned isolated process/target lifecycle with declared fakes', () => {
  it('uses exact executable, sanitized env, detached group, fresh profile and no existing CDP endpoint', async () => {
    const fixture = await fakeBrowser()
    const call = fixture.spawned.mock.calls[0] as unknown as [
      string,
      string[],
      { detached: boolean; env: Record<string, string> },
    ]
    expect(call[0]).toBe(WATCHDOG_EXECUTABLE)
    expect(call[1].slice(0, 4)).toEqual([
      '--signal=TERM',
      '--kill-after=1s',
      '180s',
      CHROME_EXECUTABLE,
    ])
    expect(call[1]).toContain('--headless=new')
    expect(call[1]).toContain('--remote-debugging-pipe')
    expect(call[1]).not.toContain('--no-sandbox')
    expect(call[2].detached).toBe(true)
    expect(Object.keys(call[2].env).sort()).toEqual([
      'HOME',
      'LANG',
      'PATH',
      'TMPDIR',
      'TZ',
      'XDG_CACHE_HOME',
      'XDG_CONFIG_HOME',
    ])
    expect(call[2].env.HOME.startsWith(`${fixture.root}/chrome-profile-`)).toBe(true)
    expect(call[2].env.TMPDIR.startsWith(`${fixture.root}/ct-`)).toBe(true)
    expect(
      Buffer.byteLength(`${call[2].env.TMPDIR}/.org.chromium.Chromium.XXXXXX/SingletonSocket`),
    ).toBeLessThan(108)
    const methods = fixture.transport.calls.map((call) => call.method)
    expect(methods.indexOf('Fetch.enable')).toBeLessThan(methods.indexOf('Target.createTarget'))
    expect(fixture.transport.calls.filter((call) => call.method === 'Fetch.enable')).toEqual([
      {
        method: 'Fetch.enable',
        sessionId: undefined,
        params: {
          patterns: [
            { urlPattern: '*', requestStage: 'Request' },
            { urlPattern: '*', requestStage: 'Response' },
          ],
          handleAuthRequests: true,
        },
      },
    ])
    const stopping = fixture.browser.stop()
    expect(fixture.browser.stop()).toBe(stopping)
    await stopping
    expect(fixture.kill).toHaveBeenCalledWith(-424242, 'SIGKILL')
    expect(fixture.browser.observations().cleanupConfirmed).toBe(true)
    expect(await readdir(fixture.root)).toEqual([])
    await expect(readdir(call[2].env.TMPDIR)).rejects.toMatchObject({ code: 'ENOENT' })
    expect(fixture.transport.closed).toBe(true)
  })
  it('keeps browser-wide interception and enables worker observation before resuming', async () => {
    const fixture = await fakeBrowser()
    fixture.transport.emit({
      method: 'Target.attachedToTarget',
      params: {
        sessionId: 'worker-session',
        targetInfo: {
          type: 'worker',
          url: 'http://127.0.0.1:9/assets/site.js',
          targetId: 'worker-target',
        },
      },
    })
    await new Promise((resolve) => setImmediate(resolve))
    const methods = fixture.transport.calls
      .filter((call) => call.sessionId === 'worker-session')
      .map((call) => call.method)
    expect(methods).not.toContain('Fetch.enable')
    expect(methods.indexOf('Network.enable')).toBeGreaterThan(-1)
    expect(methods.indexOf('Network.enable')).toBeLessThan(
      methods.indexOf('Runtime.runIfWaitingForDebugger'),
    )
    expect(fixture.failures).toEqual([])
    await fixture.browser.stop()
  })
  it('handles browser-wide worker interception without a page or worker session ID', async () => {
    const fixture = await fakeBrowser()
    fixture.transport.emit({
      method: 'Fetch.requestPaused',
      params: {
        requestId: 'worker-script',
        request: { url: 'http://127.0.0.1:9/assets/site.js', method: 'GET' },
      },
    })
    fixture.transport.emit({
      method: 'Fetch.requestPaused',
      params: {
        requestId: 'worker-egress',
        request: { url: 'https://example.invalid/secret', method: 'GET' },
      },
    })
    await new Promise((resolve) => setImmediate(resolve))
    expect(fixture.transport.calls).toContainEqual({
      method: 'Fetch.continueRequest',
      sessionId: undefined,
      params: { requestId: 'worker-script' },
    })
    expect(fixture.transport.calls).toContainEqual({
      method: 'Fetch.failRequest',
      sessionId: undefined,
      params: { requestId: 'worker-egress', errorReason: 'BlockedByClient' },
    })
    expect(fixture.failures).toContainEqual(expect.objectContaining({ code: 'network-denied' }))
    await fixture.browser.stop()
  })
  it.each(['https://example.invalid/secret', 'file:///tmp/local', 'blob:untrusted'])(
    'denies %s without continuing the request',
    async (url) => {
      const fixture = await fakeBrowser()
      fixture.transport.emit({
        method: 'Fetch.requestPaused',
        sessionId: 'page-session',
        params: { requestId: 'blocked', request: { url, method: 'GET' } },
      })
      await new Promise((resolve) => setImmediate(resolve))
      expect(fixture.transport.calls).toContainEqual({
        method: 'Fetch.failRequest',
        sessionId: 'page-session',
        params: { requestId: 'blocked', errorReason: 'BlockedByClient' },
      })
      expect(fixture.failures).toContainEqual(expect.objectContaining({ code: 'network-denied' }))
      await fixture.browser.stop()
    },
  )
  it('denies redirects, service workers and popups and kills only its own group on abort', async () => {
    const fixture = await fakeBrowser()
    fixture.transport.emit({
      method: 'Fetch.requestPaused',
      sessionId: 'page-session',
      params: {
        requestId: 'redirect',
        responseStatusCode: 302,
        request: { url: 'http://127.0.0.1:9/assets/site.js', method: 'GET' },
      },
    })
    fixture.transport.emit({
      method: 'Target.attachedToTarget',
      params: {
        sessionId: 'evil-worker',
        targetInfo: {
          type: 'service_worker',
          url: 'http://127.0.0.1:9/assets/site.js',
          targetId: 'service',
        },
      },
    })
    fixture.transport.emit({ method: 'Page.windowOpen' })
    await new Promise((resolve) => setImmediate(resolve))
    expect(fixture.failures).toHaveLength(3)
    fixture.controller.abort()
    expect(fixture.kill).toHaveBeenCalledWith(-424242, 'SIGKILL')
    await fixture.browser.stop()
  })
})

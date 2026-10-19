import { spawn, type ChildProcess } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import type { Readable, Writable } from 'node:stream'
import { DISPLAY_LIMITS } from '../../display/contract'
import type { DisplayJob } from '../../display/session'
import { DISPLAY_HANDOFF, DISPLAY_SOURCE, DISPLAY_PYTHON } from './build'
import type { DisplayHost } from './host'

export type CdpEvent = { method: string; params?: Record<string, unknown>; sessionId?: string }
export class DisplayPipe {
  private id = 0
  private buffer = Buffer.alloc(0)
  private pending = new Map<
    number,
    {
      resolve: (v: Record<string, unknown>) => void
      reject: (e: Error) => void
      timer: ReturnType<typeof setTimeout>
    }
  >()
  private listeners = new Set<(event: CdpEvent) => void>()
  private closed = false
  constructor(
    private input: Writable,
    output: Readable,
    private fail: (e: Error) => void,
  ) {
    output.on('data', (chunk: Buffer) => {
      if (this.closed) return
      if (
        this.buffer.length + chunk.length >
        4 * Math.ceil(DISPLAY_LIMITS.pngBytes / 3) + 2 * DISPLAY_LIMITS.replyBytes
      )
        return this.broken('CDP message bound.')
      this.buffer = Buffer.concat([this.buffer, chunk])
      let end: number
      while ((end = this.buffer.indexOf(0)) >= 0) {
        const text = this.buffer.subarray(0, end).toString()
        this.buffer = this.buffer.subarray(end + 1)
        try {
          const value = JSON.parse(text) as CdpEvent & {
            id?: number
            result?: Record<string, unknown>
            error?: unknown
          }
          if (value.id !== undefined) {
            const entry = this.pending.get(value.id)
            if (!entry) continue
            this.pending.delete(value.id)
            clearTimeout(entry.timer)
            if (value.error) entry.reject(new Error('Private browser command failed.'))
            else entry.resolve(value.result ?? {})
          } else if (typeof value.method === 'string') {
            for (const listener of this.listeners) listener(value)
          } else throw new Error('Invalid frame.')
        } catch {
          this.broken('Malformed CDP message.')
          return
        }
      }
    })
    output.on('error', () => this.broken('CDP read failed.'))
    output.on('end', () => this.broken('CDP ended.'))
    input.on('error', () => this.broken('CDP write failed.'))
  }
  private broken(message: string) {
    if (!this.closed) {
      this.close()
      this.fail(new Error(message))
    }
  }
  send(method: string, params: Record<string, unknown> = {}, sessionId?: string) {
    if (this.closed || this.pending.size >= 32)
      return Promise.reject(new Error('CDP closed/capacity.'))
    const id = ++this.id,
      frame = JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) })
    if (Buffer.byteLength(frame) > DISPLAY_LIMITS.replyBytes)
      return Promise.reject(new Error('CDP command bound.'))
    return new Promise<Record<string, unknown>>((resolve, reject) => {
      const timer = setTimeout(
        () => {
          this.pending.delete(id)
          reject(new Error('CDP deadline.'))
          this.broken('CDP deadline.')
        },
        method === 'Runtime.evaluate' ? DISPLAY_LIMITS.jobMs : DISPLAY_LIMITS.startupMs,
      )
      this.pending.set(id, { resolve, reject, timer })
      this.input.write(`${frame}\0`)
    })
  }
  listen(listener: (e: CdpEvent) => void) {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }
  close() {
    if (this.closed) return
    this.closed = true
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer)
      pending.reject(new Error('CDP closed.'))
    }
    this.pending.clear()
    this.listeners.clear()
    this.buffer = Buffer.alloc(0)
    this.input.end()
  }
}

/** Positive host evidence must independently agree with the page adapter before any receipt. */
export function validateHostHardware(input: Record<string, unknown>, adapter: string) {
  const gpu = input.gpu as
    | {
        devices?: {
          vendorId?: number
          deviceId?: number
          vendorString?: string
          deviceString?: string
        }[]
        auxAttributes?: Record<string, unknown>
      }
    | undefined
  const vendors: Record<number, RegExp> = {
    4318: /nvidia/i,
    32902: /intel/i,
    4098: /amd|ati/i,
    4203: /apple/i,
    20803: /qualcomm/i,
  }
  const devices = gpu?.devices
  if (
    !devices?.length ||
    devices.length > 8 ||
    /swiftshader|llvmpipe|lavapipe|software|basic render/i.test(JSON.stringify(gpu))
  )
    throw new Error('Host hardware GPU not established.')
  const ids = [...adapter.matchAll(/\b0x([\da-f]{1,8})\b/gi)].map((match) =>
    Number.parseInt(match[1], 16),
  )
  if (
    !devices.some(
      (d) =>
        d.vendorId !== undefined &&
        vendors[d.vendorId]?.test(adapter) &&
        Number.isInteger(d.deviceId) &&
        d.deviceId! > 0 &&
        (ids.includes(d.deviceId!) ||
          (d.deviceString &&
            d.deviceString.length >= 8 &&
            adapter.toLowerCase().includes(d.deviceString.toLowerCase()))),
    )
  )
    throw new Error('Page/host GPU identity mismatch (vendor alone is insufficient).')
}
/** CDP gives the full product version; Chromium may reduce the page UA to major.0.0.0. */
export function validateObservedBrowserVersion(
  pageVersion: string,
  product: string,
  userAgent: string,
) {
  const page = /^(?:HeadlessChrome|Chrome)\/(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(pageVersion)
  const host = /^(?:HeadlessChrome|Chrome)\/(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(product)
  const observed = userAgent.match(/(?:HeadlessChrome|Chrome)\/[\d.]+/)?.[0]
  if (
    !page ||
    !host ||
    observed !== pageVersion ||
    !(
      page.slice(1).every((p, i) => p === host[i + 1]) ||
      (page[1] === host[1] && page.slice(2).every((p) => p === '0'))
    )
  )
    throw new Error('Observed browser version mismatch.')
}
export function displayExpression(method: 'ready' | 'render' | 'dispose', job?: DisplayJob) {
  return `globalThis.__FURY_PRIVATE_DISPLAY__.${method}(${method === 'render' ? JSON.stringify(job) : ''})`
}
export type OwnedDisplayProcess = {
  ready(): Promise<unknown>
  render(job: DisplayJob): Promise<unknown>
  phase(phase: 'idle' | 'job'): void
  hardware: Record<string, unknown>
  version: string
  userAgent: string
  close(): Promise<void>
}

export class DisplayTeardownUncertain extends Error {}

/** Production owns only its freshly spawned supervisor and pipe-connected browser. No test driver. */
export async function openDisplayProcess(
  host: DisplayHost,
  remainingMs: number,
  onFailure: (e: Error) => void,
  signal: AbortSignal,
): Promise<OwnedDisplayProcess> {
  if (!Number.isFinite(remainingMs) || remainingMs <= 0 || remainingMs > DISPLAY_LIMITS.lifetimeMs)
    throw new Error('Invalid process lifetime.')
  signal.throwIfAborted()
  const profile = await mkdtemp(`${DISPLAY_HANDOFF}/renderer-profile-`)
  let temp: string
  try {
    signal.throwIfAborted()
    temp = await mkdtemp(`${DISPLAY_HANDOFF}/rs-`)
  } catch (error) {
    await rm(profile, { recursive: true, force: true })
    throw error
  }
  let child: ChildProcess | undefined,
    cdp: DisplayPipe | undefined,
    closing = false,
    failed: Error | undefined
  let observedExit = false,
    ownedPid: number | undefined,
    exitCode: number | null = null,
    childClosed = false
  let stopped: Promise<void> | undefined, rejectAttached: ((e: Error) => void) | undefined
  const fatal = (error: Error) => {
    if (!closing) {
      failed ??= error
      rejectAttached?.(error)
      // Supervision begins during startup, not only after a driver has been returned.
      void close().catch(() => {})
      onFailure(error)
    }
  }
  const abort = () => fatal(new Error('Owned display startup/session cancelled.'))
  const fence = () => {
    if (failed || closing) throw failed ?? new Error('Owned process closed.')
  }
  const close = () =>
    (stopped ??= (async () => {
      closing = true
      signal.removeEventListener('abort', abort)
      cdp?.close()
      if (!child?.pid) {
        await rm(profile, { recursive: true, force: true })
        await rm(temp, { recursive: true, force: true })
        return
      }
      // Do not SIGKILL the supervisor: it must remain able to reap its browser group.
      if (child.exitCode === null && child.signalCode === null)
        child.stdin?.write('{"phase":"shutdown"}\n')
      let timer: ReturnType<typeof setTimeout> | undefined
      try {
        await Promise.race([
          new Promise<void>((resolve) => {
            if (childClosed) resolve()
            else child!.once('close', () => resolve())
          }),
          new Promise<never>((_r, reject) => {
            timer = setTimeout(
              () =>
                reject(new DisplayTeardownUncertain('Owned exit uncertain; quarantine required.')),
              DISPLAY_LIMITS.cleanupMs,
            )
          }),
        ])
      } finally {
        clearTimeout(timer)
      }
      if (exitCode !== 0 || !observedExit || !ownedPid)
        throw new DisplayTeardownUncertain('Owned group exit not observed; quarantine required.')
      await rm(profile, { recursive: true, force: true, maxRetries: 0 })
      await rm(temp, { recursive: true, force: true, maxRetries: 0 })
    })())
  signal.addEventListener('abort', abort, { once: true })
  try {
    signal.throwIfAborted()
    fence()
    child = spawn(
      DISPLAY_PYTHON,
      [
        `${DISPLAY_SOURCE}/src/render/display/supervisor.py`,
        profile,
        temp,
        String(Math.floor(remainingMs)),
        String(process.pid),
      ],
      {
        detached: true,
        stdio: ['pipe', 'pipe', 'pipe', 'pipe', 'pipe'],
        env: { PATH: '/usr/bin:/bin', LANG: 'C.UTF-8', TZ: 'UTC', PYTHONDONTWRITEBYTECODE: '1' },
      },
    )
    child.once('close', () => {
      childClosed = true
    })
    child.once('error', () => fatal(new Error('Display supervisor spawn failed.')))
    child.once('exit', (code) => {
      exitCode = code
      fatal(new Error('Owned browser supervisor exited.'))
    })
    child.stdin?.on('error', () => fatal(new Error('Supervisor command pipe failed.')))
    let diagnostics = 0,
      observations = '',
      observationBytes = 0
    child.stderr?.on('data', (bytes: Buffer) => {
      diagnostics += bytes.length
      if (diagnostics > DISPLAY_LIMITS.replyBytes) fatal(new Error('Browser diagnostic cap.'))
    })
    child.stdout?.on('data', (bytes: Buffer) => {
      observationBytes += bytes.length
      if (observationBytes > 4096) return fatal(new Error('Supervisor observation cap.'))
      observations += bytes.toString()
      let newline: number
      while ((newline = observations.indexOf('\n')) >= 0) {
        const line = observations.slice(0, newline)
        observations = observations.slice(newline + 1)
        try {
          const value = JSON.parse(line) as { event?: string; pid?: number }
          if (
            value.event === 'owned' &&
            !ownedPid &&
            Number.isSafeInteger(value.pid) &&
            value.pid! > 1
          )
            ownedPid = value.pid
          else if (value.event === 'exit-observed' && value.pid === ownedPid) observedExit = true
          else throw new Error('Unexpected supervisor observation.')
        } catch {
          fatal(new Error('Invalid supervisor observation.'))
        }
      }
    })
    cdp = new DisplayPipe(child.stdio[3] as Writable, child.stdio[4] as Readable, fatal)
    const pipe = cdp
    const send = async (method: string, params: Record<string, unknown> = {}, session?: string) => {
      fence()
      const result = await pipe.send(method, params, session)
      fence()
      return result
    }
    let pageSession = '',
      pageTarget = '',
      pages = 0,
      workers = 0,
      requests = 0
    let attachedResolve: (() => void) | undefined
    const attached = new Promise<void>((resolve, reject) => {
      attachedResolve = resolve
      rejectAttached = reject
    })
    void attached.catch(() => {})
    const event = async ({ method, params: p = {}, sessionId }: CdpEvent) => {
      if (method === 'Target.attachedToTarget') {
        const info = p.targetInfo as { type: string; url: string; targetId: string }
        const session = String(p.sessionId)
        if (info.type === 'page') {
          if (++pages !== 1 || info.url !== 'about:blank')
            throw new Error('Private popup/page denied.')
          pageSession = session
          pageTarget = info.targetId
        } else if (
          info.type !== 'worker' ||
          ++workers > 1 ||
          !host.allow(info.url, 'GET') ||
          !/\/assets\/siteLight\.worker-[\w-]+\.js$/.test(info.url)
        )
          throw new Error('Unexpected private target.')
        await send(
          'Target.setAutoAttach',
          { autoAttach: true, waitForDebuggerOnStart: true, flatten: true },
          session,
        )
        await send('Network.enable', {}, session)
        await send('Network.setCacheDisabled', { cacheDisabled: true }, session)
        if (info.type === 'page')
          await send('Network.setBypassServiceWorker', { bypass: true }, session)
        await send('Runtime.enable', {}, session)
        await send('Runtime.runIfWaitingForDebugger', {}, session)
        if (info.type === 'page') attachedResolve?.()
      } else if (method === 'Fetch.requestPaused') {
        const req = p.request as { url: string; method: string; headers: Record<string, string> }
        if (
          !host.allow(req.url, req.method, !!p.redirectedRequestId) ||
          (p.responseStatusCode !== undefined && p.responseStatusCode !== 200)
        ) {
          await send(
            'Fetch.failRequest',
            { requestId: p.requestId, errorReason: 'BlockedByClient' },
            sessionId,
          )
          throw new Error('Private network request denied.')
        }
        await send(
          p.responseStatusCode === undefined ? 'Fetch.continueRequest' : 'Fetch.continueResponse',
          {
            requestId: p.requestId,
            ...(p.responseStatusCode === undefined
              ? {
                  headers: [
                    ...Object.entries(req.headers)
                      .filter(([k]) => k.toLowerCase() !== 'x-fury-display-entry')
                      .map(([name, value]) => ({ name, value })),
                    { name: 'X-Fury-Display-Entry', value: host.token },
                  ],
                }
              : {}),
          },
          sessionId,
        )
      } else if (method === 'Network.requestWillBeSent') {
        const req = p.request as { url: string; method: string }
        if (++requests > 512 || !host.allow(req.url, req.method, !!p.redirectResponse))
          throw new Error('Private network observation denied.')
      } else if (
        method === 'Runtime.exceptionThrown' ||
        method === 'Inspector.targetCrashed' ||
        method === 'Fetch.authRequired' ||
        method.startsWith('Network.webSocket') ||
        method === 'Page.windowOpen' ||
        (method === 'Runtime.consoleAPICalled' && p.type === 'error')
      )
        throw new Error('Private runtime failed.')
    }
    pipe.listen((value) => {
      void event(value).catch(fatal)
    })
    await send('Browser.setDownloadBehavior', { behavior: 'deny' })
    const version = await send('Browser.getVersion')
    if (
      typeof version.product !== 'string' ||
      typeof version.userAgent !== 'string' ||
      version.userAgent.length > 1024 ||
      !/^(HeadlessChrome|Chrome)\/[\d.]+$/.test(version.product)
    )
      throw new Error('Unknown browser version.')
    const hardware = await send('SystemInfo.getInfo')
    await send('Fetch.enable', {
      patterns: [
        { urlPattern: '*', requestStage: 'Request' },
        { urlPattern: '*', requestStage: 'Response' },
      ],
      handleAuthRequests: true,
    })
    await send('Target.setAutoAttach', {
      autoAttach: true,
      waitForDebuggerOnStart: true,
      flatten: true,
    })
    const target = await send('Target.createTarget', { url: 'about:blank' })
    await attached
    fence()
    if (target.targetId !== pageTarget) throw new Error('Owned page mismatch.')
    await send('Page.enable', {}, pageSession)
    await send('Page.navigate', { url: host.pageUrl }, pageSession)
    const evaluate = async (method: 'ready' | 'render' | 'dispose', job?: DisplayJob) => {
      const result = await send(
        'Runtime.evaluate',
        {
          expression: displayExpression(method, job),
          awaitPromise: true,
          returnByValue: true,
          userGesture: false,
        },
        pageSession,
      )
      if (result.exceptionDetails) throw new Error('Private scene call rejected.')
      return (result.result as { value?: unknown })?.value
    }
    return {
      hardware,
      version: version.product,
      userAgent: version.userAgent,
      ready: async () => {
        const started = Date.now()
        while (Date.now() - started < DISPLAY_LIMITS.startupMs) {
          const result = await send(
            'Runtime.evaluate',
            {
              expression: 'typeof globalThis.__FURY_PRIVATE_DISPLAY__ === "object"',
              returnByValue: true,
            },
            pageSession,
          )
          if ((result.result as { value?: unknown })?.value === true) return evaluate('ready')
          await new Promise((resolve) => setTimeout(resolve, 50))
          fence()
        }
        throw new Error('Private entry deadline.')
      },
      render: (job) => evaluate('render', job),
      phase: (phase) => {
        fence()
        child!.stdin!.write(`${JSON.stringify({ phase })}\n`)
      },
      close,
    }
  } catch (error) {
    try {
      await close()
    } catch (cleanup) {
      throw new DisplayTeardownUncertain('Startup teardown uncertain; ownership retained.', {
        cause: cleanup,
      })
    }
    throw error
  }
}

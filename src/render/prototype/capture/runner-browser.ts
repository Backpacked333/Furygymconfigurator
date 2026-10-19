import { spawn, type ChildProcess } from 'node:child_process'
import { constants } from 'node:fs'
import { access, mkdtemp, realpath, rm } from 'node:fs/promises'
import { join } from 'node:path'
import type { Readable, Writable } from 'node:stream'
import {
  CAPTURE_LIMITS,
  CaptureContractError,
  WORKER_GLOBAL,
  parseCaptureRuntime,
  type CaptureJob,
  type CaptureRuntime,
} from './contract'
import { HANDOFF_ROOT, type CaptureHost } from './host'

export const CHROME_EXECUTABLE =
  '/opt/.devin/chrome/chrome/linux-137.0.7118.2/chrome-linux64/chrome'
export const WATCHDOG_EXECUTABLE = '/usr/bin/timeout'
const MAX_MESSAGE = 4 * Math.ceil(CAPTURE_LIMITS.pngBytes / 3) + 2 * CAPTURE_LIMITS.metadataBytes
const DIAGNOSTIC_METHODS = new Set([
  'Browser.getVersion',
  'Target.setAutoAttach',
  'Target.createTarget',
  'Fetch.enable',
  'Fetch.failRequest',
  'Fetch.continueRequest',
  'Network.enable',
  'Network.setCacheDisabled',
  'Network.setBypassServiceWorker',
  'Runtime.enable',
  'Runtime.runIfWaitingForDebugger',
  'Runtime.evaluate',
  'Page.enable',
  'Page.navigate',
])
export type CdpEvent = { method: string; params?: Record<string, unknown>; sessionId?: string }
export interface CdpTransport {
  send(
    method: string,
    params?: Record<string, unknown>,
    sessionId?: string,
  ): Promise<Record<string, unknown>>
  listen(listener: (event: CdpEvent) => void): () => void
  close(): void
}

/** Bounded null-framed CDP pipe; no public debugging TCP port or existing browser connection. */
export class PipeCdp implements CdpTransport {
  private id = 0
  private buffer = Buffer.alloc(0)
  private pending = new Map<
    number,
    {
      resolve: (value: Record<string, unknown>) => void
      reject: (error: Error) => void
      timer: ReturnType<typeof setTimeout>
      method: string
    }
  >()
  private listeners = new Set<(event: CdpEvent) => void>()
  private closed = false
  constructor(
    private readonly input: Writable,
    output: Readable,
    private readonly onFailure: (error: Error) => void,
    private readonly onDiagnostic?: (code: string) => void,
  ) {
    output.on('data', (chunk: Buffer) => {
      if (this.closed) return
      if (this.buffer.length + chunk.length > MAX_MESSAGE)
        return this.fail(new CaptureContractError('limit-exceeded', 'CDP message cap exceeded.'))
      this.buffer = Buffer.concat([this.buffer, chunk])
      let end: number
      while ((end = this.buffer.indexOf(0)) >= 0) {
        const text = this.buffer.subarray(0, end).toString('utf8')
        this.buffer = this.buffer.subarray(end + 1)
        try {
          const value = JSON.parse(text) as {
            id?: number
            result?: Record<string, unknown>
            error?: unknown
          } & CdpEvent
          if (value.id !== undefined) {
            const entry = this.pending.get(value.id)
            if (!entry) continue
            this.pending.delete(value.id)
            clearTimeout(entry.timer)
            if (value.error) {
              this.onDiagnostic?.(
                DIAGNOSTIC_METHODS.has(entry.method)
                  ? `cdp-command-failed:${entry.method}`
                  : 'cdp-command-failed:other',
              )
              entry.reject(
                new CaptureContractError('scene-failed', 'Private browser command failed.'),
              )
            } else entry.resolve(value.result ?? {})
          } else if (typeof value.method === 'string') {
            for (const listener of this.listeners) listener(value)
          } else throw new Error('Invalid frame')
        } catch {
          this.fail(new CaptureContractError('scene-failed', 'Malformed private browser message.'))
          return
        }
      }
    })
    output.on('error', () =>
      this.fail(new CaptureContractError('scene-failed', 'Private browser pipe failed.')),
    )
    output.on('end', () =>
      this.fail(new CaptureContractError('scene-failed', 'Private browser pipe ended.')),
    )
    input.on('error', () =>
      this.fail(new CaptureContractError('scene-failed', 'Private browser input failed.')),
    )
  }
  private fail(error: Error) {
    if (!this.closed) {
      this.close()
      this.onFailure(error)
    }
  }
  send(method: string, params: Record<string, unknown> = {}, sessionId?: string) {
    if (this.closed || this.pending.size >= 32)
      return Promise.reject(
        new CaptureContractError('limit-exceeded', 'Private browser command cap/closed transport.'),
      )
    const id = ++this.id,
      frame = JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) })
    if (Buffer.byteLength(frame) > CAPTURE_LIMITS.metadataBytes)
      return Promise.reject(
        new CaptureContractError('limit-exceeded', 'Browser command too large.'),
      )
    return new Promise<Record<string, unknown>>((resolve, reject) => {
      const timer = setTimeout(
        () => {
          this.pending.delete(id)
          reject(new CaptureContractError('timeout', 'Private browser command timed out.'))
        },
        method === 'Runtime.evaluate' ? CAPTURE_LIMITS.jobMs : CAPTURE_LIMITS.startupMs,
      )
      this.pending.set(id, { resolve, reject, timer, method })
      this.input.write(`${frame}\0`)
    })
  }
  listen(listener: (event: CdpEvent) => void) {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }
  close() {
    if (this.closed) return
    this.closed = true
    for (const entry of this.pending.values()) {
      clearTimeout(entry.timer)
      entry.reject(new CaptureContractError('cancelled', 'Private browser transport closed.'))
    }
    this.pending.clear()
    this.listeners.clear()
    this.input.end()
    this.buffer = Buffer.alloc(0)
  }
}

// Fixed diagnostic vocabulary only: never store raw browser stderr, script text or URLs.
export function classifyBrowserDiagnostic(text: string): string[] {
  const workerCode = text.match(
    /\[fury-capture-failure:(scene-device-failed|graphics-api-error|architecture-not-mounted|exposure-mismatch|resource-readiness-failed|resource-disposal-failed|root-unmount-failed|javascript-type-error|javascript-reference-error|unclassified-scene-failure|device-lost|shader-compilation-failed|react-assembly-failed|timer-callback-failed|site-worker-failed|site-worker-message-failed|site-field-invalid)\]/,
  )?.[1]
  const stage = text.match(
    /\[fury-capture-stage:(root-configured|scene-mounted|architecture-checked|materials-loaded|site-field-ready|warm-start|warm-complete)\]/,
  )?.[1]
  return [
    ...(workerCode ? [workerCode] : []),
    ...(stage ? [`stage:${stage}`] : []),
    ...[
      [
        /no usable sandbox|failed to move to new namespace|sandbox.*(?:failed|not supported)/i,
        'sandbox-unavailable',
      ],
      [/gpu process.*(?:failed|exit|crash)|gpu_process_host/i, 'gpu-process-failed'],
      [
        /webgl.*(?:unavailable|not supported|failed)|failed to create.*(?:context|gles)/i,
        'webgl-unavailable',
      ],
      [/shader.*(?:error|failed)|gl_invalid_operation/i, 'shader-failed'],
      [/context.*lost|device.*lost/i, 'context-lost'],
      [/out of memory|allocation.*failed/i, 'allocation-failed'],
      [
        /processsingleton|process_singleton|singleton.*socket|socket.*(?:directory|path).*failed/i,
        'profile-socket-failed',
      ],
      [/crashpad.*(?:database|failed|required)/i, 'crashpad-startup-failed'],
      [/remote.debugging.pipe|remote debugging pipe/i, 'debugging-pipe-failed'],
      [/TypeError|ReferenceError/i, 'javascript-type-or-reference-error'],
    ].flatMap(([pattern, code]) => ((pattern as RegExp).test(text) ? [code as string] : [])),
  ]
}
export type BrowserObservation = {
  cleanupConfirmed?: boolean
  initializedRuntime?: Omit<CaptureRuntime, 'effects'>
  diagnostics?: string[]
  product: string
  userAgent: string
  ownedPid: number | null
  exitCode: number | null
  signal: string | null
  stderrBytes: number
  consoleErrors: number
  requests: number
  launchAcceleration: 'software'
  launchBackend: 'webgl2'
}
export interface OwnedBrowser {
  ready(): Promise<unknown>
  render(job: CaptureJob): Promise<unknown>
  progress(): Promise<unknown>
  dispose(): Promise<void>
  stop(): Promise<void>
  observations(): BrowserObservation
}
export type BrowserSeams = {
  spawn?: typeof spawn
  transport?: (input: Writable, output: Readable, fail: (error: Error) => void) => CdpTransport
}
function browserError(message: string) {
  return new CaptureContractError('scene-failed', message)
}

/** The only expressions this bridge may evaluate. The one argument is strict job JSON, never a script. */
export function workerExpression(
  method: 'ready' | 'render' | 'progress' | 'dispose',
  job?: CaptureJob,
): string {
  return `globalThis.${WORKER_GLOBAL}.${method}(${method === 'render' ? JSON.stringify(job) : ''})`
}

/** Process/transport seams are explicit test fakes. Production always owns a new detached child group. */
export async function launchOwnedBrowser(
  options: {
    stateDirectory: string
    host: CaptureHost
    signal: AbortSignal
    fence: () => void
    onFailure: (error: Error) => void
    remainingMs?: () => number
    onObservation?: (value: BrowserObservation) => void
  },
  seams: BrowserSeams = {},
): Promise<OwnedBrowser> {
  const { host, signal, fence, onFailure } = options
  fence()
  for (const executable of [CHROME_EXECUTABLE, WATCHDOG_EXECUTABLE]) {
    try {
      await access(executable, constants.X_OK)
    } catch {
      throw new CaptureContractError(
        'unsupported-renderer',
        'Installed browser/watchdog executable unavailable.',
      )
    }
    fence()
    if ((await realpath(executable)) !== executable)
      throw browserError('Unexpected executable link.')
  }
  const profile = await mkdtemp(join(options.stateDirectory, 'chrome-profile-'))
  // Chromium places its ProcessSingleton Unix socket below TMPDIR. Nesting that
  // below an immutable UUID output/profile exceeds Linux's 108-byte sun_path.
  // Own a short, exclusive directory under the SAME handoff root, not a shared
  // browser profile or a changed render/budget namespace.
  let socketDirectory: string
  try {
    socketDirectory = await mkdtemp(join(HANDOFF_ROOT, 'ct-'))
  } catch (error) {
    await rm(profile, { recursive: true, force: true, maxRetries: 0 })
    throw error
  }
  let child: ChildProcess | undefined, transport: CdpTransport | undefined
  let stopping = false,
    pageSession = '',
    pageTarget = '',
    attachedPages = 0,
    requestCount = 0
  const observation: BrowserObservation = {
    product: '',
    userAgent: '',
    ownedPid: null,
    exitCode: null,
    signal: null,
    stderrBytes: 0,
    consoleErrors: 0,
    requests: 0,
    launchAcceleration: 'software',
    launchBackend: 'webgl2',
  }
  let failAttach: ((error: Error) => void) | undefined
  const diagnostics = new Set<string>()
  const observe = () => options.onObservation?.({ ...observation, diagnostics: [...diagnostics] })
  const diagnose = (text: string) => {
    classifyBrowserDiagnostic(text).forEach((code) => diagnostics.add(code))
    observe()
  }
  const fatal = (error: Error) => {
    if (!stopping) {
      observe()
      failAttach?.(error)
      onFailure(error)
    }
  }
  let terminationError: Error | undefined
  const terminate = () => {
    if (!child?.pid) return
    // Only the group created by our detached spawn; never a browser name, shared port or old PID.
    try {
      process.kill(-child.pid, 'SIGKILL')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ESRCH') {
        terminationError = browserError('Owned process group cleanup failed.')
        fatal(terminationError)
      }
    }
  }
  const abort = () => terminate()
  let stopped: Promise<void> | undefined
  const stop = () =>
    (stopped ??= (async () => {
      stopping = true
      signal.removeEventListener('abort', abort)
      transport?.close()
      terminate()
      if (child?.pid && child.exitCode === null && child.signalCode === null) {
        let timer: ReturnType<typeof setTimeout> | undefined
        try {
          await Promise.race([
            new Promise<void>((resolve) => child!.once('exit', () => resolve())),
            new Promise<void>((resolve) => {
              timer = setTimeout(resolve, 1000)
            }),
          ])
        } finally {
          clearTimeout(timer)
        }
        if (child.exitCode === null && child.signalCode === null)
          terminationError ??= browserError('Owned browser did not exit after termination.')
      }
      observation.cleanupConfirmed = !terminationError
      observe()
      if (terminationError) throw terminationError
      // Remove only our freshly created disposable profile, after confirmed owner exit.
      await rm(profile, { recursive: true, force: true, maxRetries: 0 })
      await rm(socketDirectory, { recursive: true, force: true, maxRetries: 0 })
    })())
  try {
    fence()
    const remainingMs = options.remainingMs?.() ?? CAPTURE_LIMITS.jobMs
    if (!Number.isFinite(remainingMs) || remainingMs <= 0 || remainingMs > CAPTURE_LIMITS.jobMs)
      throw new CaptureContractError('timeout', 'Invalid remaining browser deadline.')
    // Existing GNU timeout independently reaps this process group even if Node stalls or is killed.
    // No shell, operator command, executable override or inherited environment is involved.
    child = (seams.spawn ?? spawn)(
      WATCHDOG_EXECUTABLE,
      [
        '--signal=TERM',
        '--kill-after=1s',
        `${Math.ceil(remainingMs) / 1000}s`,
        CHROME_EXECUTABLE,
        '--headless=new',
        '--no-startup-window',
        '--remote-debugging-pipe',
        `--user-data-dir=${profile}`,
        '--no-first-run',
        '--no-default-browser-check',
        '--disable-background-networking',
        '--disable-component-update',
        '--disable-sync',
        '--disable-extensions',
        '--disable-default-apps',
        '--disable-breakpad',
        '--disable-crash-reporter',
        '--disable-domain-reliability',
        '--disable-client-side-phishing-detection',
        '--disable-component-extensions-with-background-pages',
        '--disable-features=MediaRouter,OptimizationHints,AutofillServerCommunication,Translate,ServiceWorker',
        '--metrics-recording-only',
        '--disable-notifications',
        '--disable-popup-blocking',
        '--no-proxy-server',
        '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1',
        '--disable-quic',
        '--disable-dev-shm-usage',
        '--use-gl=angle',
        '--use-angle=swiftshader',
        '--enable-unsafe-swiftshader',
        '--disable-gpu-watchdog',
        '--window-size=640,500',
        '--force-device-scale-factor=1',
        '--password-store=basic',
        '--use-mock-keychain',
      ],
      {
        detached: true,
        stdio: ['ignore', 'ignore', 'pipe', 'pipe', 'pipe'],
        env: {
          PATH: '/usr/bin:/bin',
          HOME: profile,
          TMPDIR: socketDirectory,
          XDG_CACHE_HOME: profile,
          XDG_CONFIG_HOME: profile,
          LANG: 'C.UTF-8',
          TZ: 'UTC',
        },
      },
    )
    observation.ownedPid = child.pid ?? null
    child.once('error', () => fatal(browserError('Owned browser failed to start.')))
    child.once('exit', (code, exitSignal) => {
      observation.exitCode = code
      observation.signal = exitSignal
      fatal(
        code === 124 || code === 137
          ? new CaptureContractError('timeout', 'Owned watchdog deadline elapsed.')
          : browserError('Owned browser exited.'),
      )
    })
    let stderrTail = ''
    child.stderr?.on('data', (bytes: Buffer) => {
      observation.stderrBytes += bytes.length
      const text = stderrTail + bytes.subarray(0, CAPTURE_LIMITS.metadataBytes).toString('utf8')
      diagnose(text)
      stderrTail = text.slice(-1024)
      // Raw stderr is never retained: may contain URLs, environment or arbitrary page contents.
      if (observation.stderrBytes > CAPTURE_LIMITS.metadataBytes)
        fatal(new CaptureContractError('limit-exceeded', 'Browser diagnostic byte cap exceeded.'))
    })
    signal.addEventListener('abort', abort, { once: true })
    fence()
    const input = child.stdio[3] as Writable,
      output = child.stdio[4] as Readable
    transport = (
      seams.transport ??
      ((a, b, fail) =>
        new PipeCdp(a, b, fail, (code) => {
          diagnostics.add(code)
          observe()
        }))
    )(input, output, fatal)
    const cdp = transport
    const send = async (
      method: string,
      params: Record<string, unknown> = {},
      sessionId?: string,
    ) => {
      fence()
      const result = await cdp.send(method, params, sessionId)
      fence()
      return result
    }
    let pageAttached: (() => void) | undefined
    const attached = new Promise<void>((resolve, reject) => {
      pageAttached = resolve
      failAttach = reject
    })
    void attached.catch(() => {})
    const setup = async (session: string, type: string, url: string, target: string) => {
      if (type === 'page') {
        if (++attachedPages !== 1 || url !== 'about:blank')
          throw new CaptureContractError('network-denied', 'Unexpected page/popup target denied.')
        pageSession = session
        pageTarget = target
      } else if (type !== 'worker' || !host.allow(url, 'GET')) {
        throw new CaptureContractError('network-denied', 'Unexpected browser target denied.')
      }
      await send(
        'Target.setAutoAttach',
        { autoAttach: true, waitForDebuggerOnStart: true, flatten: true },
        session,
      )
      await send('Network.enable', {}, session)
      await send('Network.setCacheDisabled', { cacheDisabled: true }, session)
      if (type === 'page') await send('Network.setBypassServiceWorker', { bypass: true }, session)
      await send('Runtime.enable', {}, session)
      await send('Runtime.runIfWaitingForDebugger', {}, session)
      if (type === 'page') pageAttached?.()
    }
    const event = async ({ method, params: p = {}, sessionId }: CdpEvent) => {
      if (method === 'Target.attachedToTarget') {
        const info = p.targetInfo as { type: string; url: string; targetId: string }
        await setup(String(p.sessionId), info.type, info.url, info.targetId)
      } else if (method === 'Fetch.requestPaused') {
        const request = p.request as { url: string; method: string }
        const status = p.responseStatusCode as number | undefined
        if (
          !host.allow(request.url, request.method, !!p.redirectedRequestId) ||
          (status !== undefined && status !== 200)
        ) {
          await send(
            'Fetch.failRequest',
            { requestId: p.requestId, errorReason: 'BlockedByClient' },
            sessionId,
          )
          throw new CaptureContractError(
            'network-denied',
            'External, redirected or unlisted browser request denied.',
          )
        }
        await send(
          status === undefined ? 'Fetch.continueRequest' : 'Fetch.continueResponse',
          { requestId: p.requestId },
          sessionId,
        )
      } else if (method === 'Network.requestWillBeSent') {
        const request = p.request as { url: string; method: string }
        observation.requests = ++requestCount
        if (
          requestCount > CAPTURE_LIMITS.resourceRequests ||
          !host.allow(request.url, request.method, !!p.redirectResponse)
        )
          throw new CaptureContractError('network-denied', 'Unexpected browser network request.')
      } else if (
        method === 'Fetch.authRequired' ||
        method.startsWith('Network.webSocket') ||
        method === 'Page.windowOpen'
      ) {
        throw new CaptureContractError('network-denied', 'Browser auth, websocket or popup denied.')
      } else if (method === 'Runtime.exceptionThrown' || method === 'Inspector.targetCrashed') {
        observation.consoleErrors++
        const details = p.exceptionDetails as
          { text?: string; exception?: { description?: string } } | undefined
        diagnose(`${details?.text ?? ''} ${details?.exception?.description ?? ''}`)
        diagnostics.add(
          method === 'Inspector.targetCrashed' ? 'target-crashed' : 'uncaught-exception',
        )
        throw browserError('Private worker exception or crash.')
      } else if (
        method === 'Runtime.consoleAPICalled' &&
        p.type === 'info' &&
        (p.args as { value?: unknown }[] | undefined)?.[0]?.value === 'fury-capture-runtime'
      ) {
        const value = (p.args as { value?: unknown }[])[1]?.value
        if (typeof value !== 'string' || value.length > CAPTURE_LIMITS.metadataBytes)
          throw browserError('Invalid runtime diagnostic.')
        const { backend, acceleration, adapter, browserVersion, userAgent } = parseCaptureRuntime(
          JSON.parse(value),
        )
        // Initialization is observed; effects have NOT settled and must not be claimed here.
        observation.initializedRuntime = {
          backend,
          acceleration,
          adapter,
          browserVersion,
          userAgent,
        }
        observe()
      } else if (method === 'Runtime.consoleAPICalled' && p.type === 'error') {
        diagnose(JSON.stringify(p.args ?? []).slice(0, CAPTURE_LIMITS.metadataBytes))
        if (++observation.consoleErrors > 32)
          throw browserError('Private worker console error cap exceeded.')
      } else if (method === 'Runtime.consoleAPICalled' && p.type === 'info') {
        diagnose(JSON.stringify(p.args ?? []).slice(0, CAPTURE_LIMITS.metadataBytes))
      }
    }
    cdp.listen((message) => {
      void event(message).catch(fatal)
    })
    await send('Browser.setDownloadBehavior', { behavior: 'deny' })
    const version = await send('Browser.getVersion')
    if (
      typeof version.product !== 'string' ||
      typeof version.userAgent !== 'string' ||
      version.product.length > 512 ||
      version.userAgent.length > 512
    )
      throw browserError('Invalid browser runtime metadata.')
    observation.product = version.product
    observation.userAgent = version.userAgent
    // Chromium exposes Fetch on the browser target, not dedicated-worker targets. Browser-wide
    // interception covers the page, worker script and worker requests before any target runs.
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
    if (target.targetId !== pageTarget) throw browserError('Unexpected owned page target.')
    await send('Page.enable', {}, pageSession)
    await send('Page.navigate', { url: host.pageUrl }, pageSession)
    const evaluate = async (
      method: 'ready' | 'render' | 'progress' | 'dispose',
      job?: CaptureJob,
    ) => {
      const response = await send(
        'Runtime.evaluate',
        {
          expression: workerExpression(method, job),
          awaitPromise: true,
          returnByValue: true,
          userGesture: false,
        },
        pageSession,
      )
      if (response.exceptionDetails) {
        diagnose(JSON.stringify(response.exceptionDetails).slice(0, CAPTURE_LIMITS.metadataBytes))
        throw browserError('Private page method failed.')
      }
      return (response.result as { value?: unknown } | undefined)?.value
    }
    return {
      ready: async () => {
        // Worker module registration is async to navigation; a fixed probe only, no caller script.
        for (;;) {
          const probe = await send(
            'Runtime.evaluate',
            { expression: `typeof globalThis.${WORKER_GLOBAL} === 'object'`, returnByValue: true },
            pageSession,
          )
          if ((probe.result as { value?: unknown })?.value === true) return evaluate('ready')
          await new Promise((resolve) => setTimeout(resolve, 50))
          fence()
        }
      },
      render: (job) => evaluate('render', job),
      progress: () => evaluate('progress'),
      dispose: async () => {
        if (!stopping) {
          await Promise.race([
            cdp.send(
              'Runtime.evaluate',
              { expression: workerExpression('dispose'), awaitPromise: true, returnByValue: true },
              pageSession,
            ),
            new Promise((resolve) => setTimeout(resolve, 500)),
          ])
        }
      },
      stop,
      observations: () => ({ ...observation, diagnostics: [...diagnostics] }),
    }
  } catch (error) {
    await stop()
    throw error
  }
}

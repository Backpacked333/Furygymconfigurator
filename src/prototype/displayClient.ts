import type { DesignEnvelope } from '../domain/design'
import {
  DISPLAY_LIMITS,
  DISPLAY_PROTOCOL,
  DISPLAY_REQUEST_PATH,
  createDisplayRequest,
  displayCancelPath,
  displayErrorReplySchema,
  displayImagePath,
  displayStatusPath,
  parseDisplayReply,
  validateDisplayImage,
  type DisplayBinding,
  type DisplayReadyReply,
  type DisplayReply,
} from '../display/contract'

export const DISPLAY_CLIENT_DEADLINE_MS = DISPLAY_LIMITS.interestMs
export const DISPLAY_CLIENT_POLL_LIMIT = 600
export type DisplayProgress =
  | { state: 'pending' }
  | { state: 'ready'; reply: DisplayReadyReply; src: string }
  | { state: 'error' | 'unavailable'; message: string; retryable: false }

/** Injection is a unit-test seam, not a browser-selected endpoint or renderer. */
export type DisplayTransport = {
  origin: string
  fetch: typeof fetch
  decode: (bytes: Uint8Array, signal: AbortSignal) => Promise<{ width: number; height: number }>
  createObjectURL: (blob: Blob) => string
  revokeObjectURL: (url: string) => void
}

/** Keep one bounded request alive and replace only the not-yet-submitted selection. */
export function createDisplaySelectionQueue(start = startDisplayRequest) {
  return createBoundedDisplaySelectionQueue<DisplayProgress>(start)
}

/** Shared scheduling only: each wire keeps its own provenance and validators. */
export function createBoundedDisplaySelectionQueue<
  P extends { state: 'pending' | 'ready' | 'error' | 'unavailable' },
>(
  start: (
    design: DesignEnvelope,
    notify: (progress: P | { state: 'pending' }) => void,
  ) => () => void,
) {
  type Selection = { design: DesignEnvelope; notify: (progress: P | { state: 'pending' }) => void }
  let latest: Selection | undefined
  let pending: Selection | undefined
  let running: { selection: Selection; settled: boolean; stop?: () => void } | undefined
  let disposed = false
  function pump() {
    if (disposed || !pending || (running && !running.settled)) return
    running?.stop?.()
    const operation = {
      selection: pending,
      settled: false,
      stop: undefined as (() => void) | undefined,
    }
    pending = undefined
    running = operation
    operation.stop = start(operation.selection.design, (progress) => {
      if (disposed || running !== operation || operation.settled) return
      if (progress.state !== 'pending') operation.settled = true
      if (latest === operation.selection) operation.selection.notify(progress)
      if (operation.settled && pending) queueMicrotask(pump)
    })
  }
  return {
    select(design: DesignEnvelope, notify: (progress: P | { state: 'pending' }) => void) {
      if (disposed) return
      pending = latest = { design, notify }
      notify({ state: 'pending' })
      // Defer submission past StrictMode's setup/cleanup probe, not past user acknowledgement.
      queueMicrotask(pump)
    },
    dispose() {
      disposed = true
      pending = latest = undefined
      running?.stop?.()
      running = undefined
    },
  }
}

export async function decodeDisplayImage(bytes: Uint8Array, signal: AbortSignal) {
  signal.throwIfAborted()
  const blob = new Blob([new Uint8Array(bytes)], { type: 'image/png' })
  if (typeof createImageBitmap === 'function') {
    const bitmap = await createImageBitmap(blob)
    try {
      signal.throwIfAborted()
      return { width: bitmap.width, height: bitmap.height }
    } finally {
      bitmap.close()
    }
  }
  const url = URL.createObjectURL(blob)
  const image = new Image()
  let abort: (() => void) | undefined
  try {
    image.src = url
    await Promise.race([
      image.decode(),
      new Promise<never>((_resolve, reject) => {
        abort = () => reject(signal.reason)
        signal.addEventListener('abort', abort, { once: true })
        if (signal.aborted) abort()
      }),
    ])
    signal.throwIfAborted()
    return { width: image.naturalWidth, height: image.naturalHeight }
  } finally {
    if (abort) signal.removeEventListener('abort', abort)
    image.src = ''
    URL.revokeObjectURL(url)
  }
}

export class DisplayClientError extends Error {
  constructor(
    message: string,
    readonly unavailable = false,
  ) {
    super(message)
  }
}

export function localOrigin(origin: string) {
  const url = new URL(origin)
  if (
    !import.meta.env.DEV ||
    url.protocol !== 'http:' ||
    !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) ||
    url.origin !== origin ||
    url.username ||
    url.password
  )
    throw new DisplayClientError('Private display requires a loopback DEV origin.', true)
  return origin
}

export function checkResponse(response: Response, url: string, media: string) {
  if (response.redirected || response.url !== url)
    throw new DisplayClientError('Private display response destination does not match.')
  const encoding = response.headers.get('content-encoding')
  if (encoding && encoding !== 'identity')
    throw new DisplayClientError('Compressed private display responses are not accepted.')
  const type = response.headers.get('content-type')?.toLowerCase().trim()
  if (type !== media && !(media === 'application/json' && type === `${media}; charset=utf-8`))
    throw new DisplayClientError('Private display service unavailable or wrong media type.', true)
}

export function discard(response: Response) {
  void response.body?.cancel().catch(() => undefined)
}

export async function readBytes(response: Response, cap: number, signal: AbortSignal) {
  signal.throwIfAborted()
  const length = response.headers.get('content-length')
  if (length !== null && (!/^\d+$/.test(length) || Number(length) > cap)) {
    discard(response)
    throw new DisplayClientError('Private display response length exceeds its bound.')
  }
  if (!response.body) throw new DisplayClientError('Private display response body is missing.')
  const reader = response.body.getReader()
  const abort = () => {
    void reader.cancel().catch(() => undefined)
  }
  signal.addEventListener('abort', abort, { once: true })
  let size = 0
  const chunks: Uint8Array[] = []
  try {
    while (true) {
      signal.throwIfAborted()
      const part = await reader.read()
      signal.throwIfAborted()
      if (part.done) break
      size += part.value.byteLength
      if (size > cap)
        throw new DisplayClientError('Private display response exceeded its byte cap.')
      chunks.push(part.value)
    }
    if (length !== null && Number(length) !== size)
      throw new DisplayClientError('Private display response length does not match.')
  } catch (error) {
    abort()
    throw error
  } finally {
    signal.removeEventListener('abort', abort)
    reader.releaseLock()
  }
  const bytes = new Uint8Array(size)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  return bytes
}

async function readMetadata(
  response: Response,
  url: string,
  signal: AbortSignal,
): Promise<unknown> {
  try {
    checkResponse(response, url, 'application/json')
  } catch (error) {
    discard(response)
    throw error
  }
  const bytes = await readBytes(response, DISPLAY_LIMITS.replyBytes, signal)
  signal.throwIfAborted()
  const body: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))
  if (!response.ok) {
    const parsed = displayErrorReplySchema.safeParse(body)
    throw new DisplayClientError(
      parsed.success
        ? `Private display unavailable (${parsed.data.error.code}). Operator review is required; no automatic retry or fallback.`
        : 'Private display unavailable. No historical, mock or Lite image was substituted.',
      true,
    )
  }
  return body
}

function checkStatus(status: number, reply: DisplayReply, submission = false) {
  const pending = reply.state === 'queued' || reply.state === 'rendering'
  if (status !== (pending ? 202 : 200) || (submission && !pending && reply.state !== 'ready'))
    throw new DisplayClientError('Private display HTTP status and image state disagree.')
}

/**
 * One selection generation, never resubmitted. Cleanup aborts local delivery and detaches ONLY
 * its owned interest. A cancellation request is not evidence of shared work or host shutdown.
 */
export function startDisplayRequest(
  inputDesign: DesignEnvelope,
  notify: (progress: DisplayProgress) => void,
  transport: DisplayTransport = {
    origin: window.location.origin,
    fetch: (...args) => fetch(...args),
    decode: decodeDisplayImage,
    createObjectURL: (blob) => URL.createObjectURL(blob),
    revokeObjectURL: (url) => URL.revokeObjectURL(url),
  },
): () => void {
  let request: ReturnType<typeof createDisplayRequest>, origin: string
  try {
    request = createDisplayRequest(inputDesign)
    origin = localOrigin(transport.origin)
  } catch {
    notify({
      state: 'unavailable',
      message: 'Private display requires a valid full design and a loopback DEV origin.',
      retryable: false,
    })
    return () => undefined
  }
  const design = request.design
  const controller = new AbortController()
  const options = {
    credentials: 'same-origin',
    mode: 'same-origin',
    cache: 'no-store',
    redirect: 'error',
    signal: controller.signal,
  } as const
  let active = true,
    detached = false
  let expected: { interestId: string; binding: DisplayBinding } | undefined
  let ownedUrl: string | undefined
  let waitTimer: ReturnType<typeof setTimeout> | undefined
  let stopWait: (() => void) | undefined
  const publish = (progress: DisplayProgress) => {
    if (active) notify(progress)
  }
  const assertActive = () => {
    controller.signal.throwIfAborted()
    if (!active) throw new DOMException('Obsolete display generation.', 'AbortError')
  }
  const wait = (ms: number) =>
    new Promise<void>((resolve) => {
      stopWait = resolve
      waitTimer = setTimeout(resolve, ms)
    })
  function detach() {
    if (!expected || detached) return
    detached = true
    const binding = expected
    const cancel = new AbortController()
    const timer = setTimeout(() => cancel.abort(), 3000)
    const url = origin + displayCancelPath(binding.interestId)
    void (async () => {
      try {
        const response = await transport.fetch(url, {
          ...options,
          signal: cancel.signal,
          method: 'POST',
          keepalive: true,
          headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
          body: JSON.stringify({ protocol: DISPLAY_PROTOCOL }),
        })
        if (cancel.signal.aborted) {
          discard(response)
          return
        }
        const body = await readMetadata(response, url, cancel.signal)
        cancel.signal.throwIfAborted()
        const reply = await parseDisplayReply(body, design, binding)
        cancel.signal.throwIfAborted()
        if (response.status !== 200 || reply.state !== 'cancelled')
          throw new DisplayClientError('Invalid interest cancellation reply.')
      } catch {
        // Best effort only; no UI claim of cancellation/host shutdown. Server expiry is bounded.
      } finally {
        clearTimeout(timer)
      }
    })()
  }
  const deadline = setTimeout(() => {
    publish({
      state: 'unavailable',
      message:
        'Private display wait expired. Shared work may continue; operator review is required. No image was substituted.',
      retryable: false,
    })
    active = false
    controller.abort()
    stopWait?.()
    detach()
  }, DISPLAY_CLIENT_DEADLINE_MS)
  publish({ state: 'pending' })
  void (async () => {
    try {
      // Collapse rapid edits and StrictMode probe mounts, without delaying controls/history.
      await wait(120)
      assertActive()
      const body = JSON.stringify(request)
      if (new TextEncoder().encode(body).byteLength > DISPLAY_LIMITS.requestBytes)
        throw new DisplayClientError('Private display request exceeded its byte cap.')
      const url = origin + DISPLAY_REQUEST_PATH
      const response = await transport.fetch(url, {
        ...options,
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body,
      })
      // After abort a transport may still return an admitted interest. This bounded branch may
      // ONLY validate and detach it; it cannot poll, fetch pixels or publish to this generation.
      const late = !active || controller.signal.aborted
      const cleanup = new AbortController()
      const cleanupTimer = setTimeout(() => cleanup.abort(), 3000)
      let reply: DisplayReply
      try {
        const signal = late ? cleanup.signal : controller.signal
        const metadata = await readMetadata(response, url, signal)
        signal.throwIfAborted()
        reply = await parseDisplayReply(metadata, design)
        // Keep only the validated capability for detach if cancellation won during identity hashing.
        expected = { interestId: reply.interestId, binding: reply.binding }
        signal.throwIfAborted()
        checkStatus(response.status, reply, true)
      } finally {
        clearTimeout(cleanupTimer)
      }
      if (late || !active) {
        detach()
        return
      }
      assertActive()
      let polls = 0
      while (reply.state === 'queued' || reply.state === 'rendering') {
        if (polls++ >= DISPLAY_CLIENT_POLL_LIMIT)
          throw new DisplayClientError(
            'Private display polling cap reached; operator review is required.',
            true,
          )
        await wait(Math.max(500, reply.retryAfterMs))
        assertActive()
        const statusUrl = origin + displayStatusPath(expected.interestId)
        const response = await transport.fetch(statusUrl, {
          ...options,
          headers: { Accept: 'application/json' },
        })
        if (!active) {
          discard(response)
          return
        }
        assertActive()
        const metadata = await readMetadata(response, statusUrl, controller.signal)
        assertActive()
        reply = await parseDisplayReply(metadata, design, expected)
        assertActive()
        checkStatus(response.status, reply)
      }
      if (reply.state === 'failed')
        throw new DisplayClientError(
          `Private display failed (${reply.error.code}). Operator review is required; no retry was started.`,
          reply.error.code === 'execution-denied' || reply.error.code === 'unavailable',
        )
      if (reply.state !== 'ready')
        throw new DisplayClientError(
          `Private display interest ${reply.state}. No matching image is available.`,
          true,
        )
      const imageUrl = origin + displayImagePath(expected.interestId, reply.artifact.checksum)
      const png = await transport.fetch(imageUrl, { ...options, headers: { Accept: 'image/png' } })
      if (!active) {
        discard(png)
        return
      }
      assertActive()
      try {
        checkResponse(png, imageUrl, 'image/png')
        if (png.status !== 200)
          throw new DisplayClientError('Private display PNG unavailable.', true)
      } catch (error) {
        discard(png)
        throw error
      }
      const bytes = await readBytes(png, DISPLAY_LIMITS.pngBytes, controller.signal)
      assertActive()
      await validateDisplayImage(reply.artifact, bytes, async (snapshot) => {
        // This callback is entered AFTER the shared validator's asynchronous SHA-256 completes.
        assertActive()
        const dimensions = await transport.decode(snapshot, controller.signal)
        assertActive()
        return dimensions
      })
      assertActive()
      ownedUrl = transport.createObjectURL(new Blob([new Uint8Array(bytes)], { type: 'image/png' }))
      publish({ state: 'ready', reply, src: ownedUrl })
    } catch (error) {
      publish({
        state: error instanceof DisplayClientError && error.unavailable ? 'unavailable' : 'error',
        message:
          error instanceof DisplayClientError
            ? error.message
            : 'Private display identity, PNG bytes or decode could not be verified. No image was substituted; operator review is required.',
        retryable: false,
      })
      detach()
    } finally {
      clearTimeout(deadline)
      clearTimeout(waitTimer)
    }
  })()
  return () => {
    active = false
    controller.abort()
    clearTimeout(deadline)
    clearTimeout(waitTimer)
    stopWait?.()
    detach()
    if (ownedUrl) {
      transport.revokeObjectURL(ownedUrl)
      ownedUrl = undefined
    }
  }
}

import type { DesignEnvelope } from '../domain/design'
import {
  LOCAL_RENDER_REQUEST_PATH,
  MAX_LOCAL_RENDER_REQUEST_BYTES,
  MAX_LOCAL_RENDER_REPLY_BYTES,
  MAX_LOCAL_RENDER_PNG_BYTES,
  UnsupportedLocalRenderDesignError,
  createLocalRenderRequest,
  createLocalRenderCancelRequest,
  localRenderStatusPath,
  localRenderCancelPath,
  localRenderImagePath,
  localRenderErrorReplySchema,
  parseLocalRenderSubmissionReply,
  parseLocalRenderStatusReply,
  parseLocalRenderCancelReply,
  validateLocalRenderImage,
  type LocalRenderCaptureBinding,
  type LocalRenderReadyReply,
  type LocalRenderImageDecoder,
} from '../image-service/localRenderProtocol'

export const LOCAL_RENDER_CLIENT_DEADLINE_MS = 200_000
export const LOCAL_RENDER_POLL_LIMIT = 400
export type LocalRenderProgress =
  | { state: 'pending' }
  | { state: 'ready'; reply: LocalRenderReadyReply; src: string }
  | { state: 'error' | 'unavailable'; message: string; retryable: false }

/** Injected transports/decoders are test seams, never evidence of actual rendered pixels. */
export type LocalRenderTransport = {
  origin: string
  fetch: typeof fetch
  decode: (bytes: Uint8Array, signal: AbortSignal) => ReturnType<LocalRenderImageDecoder>
  createObjectURL: (blob: Blob) => string
  revokeObjectURL: (url: string) => void
}

export async function decodeLocalRenderImage(bytes: Uint8Array, signal: AbortSignal) {
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

class LocalPreviewError extends Error {
  constructor(
    message: string,
    readonly unavailable = false,
  ) {
    super(message)
  }
}

function localOrigin(origin: string): string {
  const url = new URL(origin)
  if (
    !import.meta.env.DEV ||
    url.protocol !== 'http:' ||
    !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) ||
    url.origin !== origin ||
    url.username ||
    url.password
  )
    throw new LocalPreviewError('Local render delivery requires a loopback DEV origin.', true)
  return origin
}

/** Check the actual fetch destination; a redirect or fallback HTML is never a local artifact. */
function checkResponse(response: Response, url: string, media: string) {
  if (response.redirected || response.url !== url)
    throw new LocalPreviewError('Local render response URL differs from the exact request.')
  if (
    response.headers.get('content-encoding') &&
    response.headers.get('content-encoding') !== 'identity'
  )
    throw new LocalPreviewError('Compressed local render responses are not accepted.')
  const type = response.headers.get('content-type')?.toLowerCase().trim()
  if (
    type !== media &&
    !(media === 'application/json' && type === 'application/json; charset=utf-8')
  )
    throw new LocalPreviewError(
      'Local render service unavailable or returned the wrong media type.',
      true,
    )
}

async function readBytes(
  response: Response,
  cap: number,
  signal: AbortSignal,
): Promise<Uint8Array> {
  if (!response.body) throw new LocalPreviewError('Local render response body is missing.')
  const reader = response.body.getReader()
  const abort = () => {
    void reader.cancel().catch(() => undefined)
  }
  signal.addEventListener('abort', abort, { once: true })
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    while (true) {
      signal.throwIfAborted()
      const part = await reader.read()
      signal.throwIfAborted()
      if (part.done) break
      size += part.value.byteLength
      if (size > cap) {
        await reader.cancel()
        throw new LocalPreviewError('Local render response exceeded its byte limit.')
      }
      chunks.push(part.value)
    }
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
  checkResponse(response, url, 'application/json')
  const bytes = await readBytes(response, MAX_LOCAL_RENDER_REPLY_BYTES, signal)
  const body: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))
  if (!response.ok) {
    const parsed = localRenderErrorReplySchema.safeParse(body)
    throw new LocalPreviewError(
      parsed.success
        ? `Local render unavailable (${parsed.data.error.code}). Operator review is required; no automatic retry or fallback.`
        : 'Local render service unavailable. No mock, historical or cloud image was substituted.',
      true,
    )
  }
  return body
}

/**
 * One frozen selection generation. No automatic resubmission or user retry after uncertain work.
 * Cleanup revokes its URL and detaches only its interest; shared capture may continue server-side.
 */
export function startLocalRenderRequest(
  inputDesign: DesignEnvelope,
  notify: (progress: LocalRenderProgress) => void,
  transport: LocalRenderTransport = {
    origin: window.location.origin,
    fetch: (...args) => fetch(...args),
    decode: decodeLocalRenderImage,
    createObjectURL: (blob) => URL.createObjectURL(blob),
    revokeObjectURL: (url) => URL.revokeObjectURL(url),
  },
): () => void {
  let request: ReturnType<typeof createLocalRenderRequest>, origin: string
  try {
    request = createLocalRenderRequest(inputDesign)
    origin = localOrigin(transport.origin)
  } catch (error) {
    notify({
      state: 'unavailable',
      message:
        error instanceof UnsupportedLocalRenderDesignError || error instanceof LocalPreviewError
          ? error.message
          : 'No matching rendered preview: the full design could not be validated.',
      retryable: false,
    })
    return () => undefined
  }
  const design = request.design
  let active = true,
    detached = false,
    interest: string | null = null
  let capture: LocalRenderCaptureBinding | undefined
  let ownedUrl: string | undefined
  let waitTimer: ReturnType<typeof setTimeout> | undefined
  let stopWait: (() => void) | undefined
  const controller = new AbortController()
  const options = {
    credentials: 'same-origin',
    mode: 'same-origin',
    cache: 'no-store',
    redirect: 'error',
    signal: controller.signal,
  } as const
  const publish = (progress: LocalRenderProgress) => {
    if (active) notify(progress)
  }
  const wait = (ms: number) =>
    new Promise<void>((resolve) => {
      stopWait = resolve
      waitTimer = setTimeout(resolve, ms)
    })
  function detach() {
    if (!interest || !capture || detached) return
    detached = true
    const id = interest,
      binding = capture
    const cancel = new AbortController()
    const timeout = setTimeout(() => cancel.abort(), 3000)
    const url = origin + localRenderCancelPath(id)
    void transport
      .fetch(url, {
        ...options,
        signal: cancel.signal,
        method: 'POST',
        keepalive: true,
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify(createLocalRenderCancelRequest(id)),
      })
      .then(async (response) => {
        const body = await readMetadata(response, url, cancel.signal)
        if (response.status !== 200) throw new Error('Unexpected cancellation status.')
        await parseLocalRenderCancelReply(body, design, id, binding)
      })
      .catch(() => undefined)
      .finally(() => clearTimeout(timeout))
  }
  const deadline = setTimeout(() => {
    publish({
      state: 'unavailable',
      message:
        'Local render wait timed out. Shared work may continue; operator review is required before retry.',
      retryable: false,
    })
    active = false
    controller.abort()
    stopWait?.()
    detach()
  }, LOCAL_RENDER_CLIENT_DEADLINE_MS)
  publish({ state: 'pending' })
  void (async () => {
    try {
      // Admission debounce collapses rapid edits, including React StrictMode's probe mount.
      await wait(120)
      if (!active) return
      const body = JSON.stringify(request)
      if (new TextEncoder().encode(body).byteLength > MAX_LOCAL_RENDER_REQUEST_BYTES)
        throw new LocalPreviewError('Local render request exceeded its byte limit.')
      const url = origin + LOCAL_RENDER_REQUEST_PATH
      const response = await transport.fetch(url, {
        ...options,
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body,
      })
      // A transport can finish after abort. Validate a late submission solely to detach its interest.
      const late = new AbortController()
      const lateDeadline = setTimeout(() => late.abort(), 3000)
      let metadata: unknown
      try {
        metadata = await readMetadata(response, url, active ? controller.signal : late.signal)
      } finally {
        clearTimeout(lateDeadline)
      }
      let reply = (await parseLocalRenderSubmissionReply(response.status, metadata, design)).body
      interest = reply.interestId
      capture = reply.capture
      if (!active) {
        detach()
        return
      }
      let polls = 0
      while (reply.state === 'queued' || reply.state === 'rendering') {
        if (polls++ >= LOCAL_RENDER_POLL_LIMIT)
          throw new LocalPreviewError(
            'Local render polling limit reached. Operator review is required before retry.',
            true,
          )
        await wait(Math.max(500, reply.retryAfterMs))
        if (!active) return
        const statusUrl = origin + localRenderStatusPath(interest)
        const response = await transport.fetch(statusUrl, {
          ...options,
          headers: { Accept: 'application/json' },
        })
        if (!active) return
        const body = await readMetadata(response, statusUrl, controller.signal)
        if (!active) return
        if (response.status !== 200)
          throw new LocalPreviewError('Unexpected local render status response.')
        const next = await parseLocalRenderStatusReply(body, design, interest, capture)
        if (!active) return
        if (next.state === 'failed')
          throw new LocalPreviewError(
            `Local render failed (${next.error.code}). Operator review is required; no capture retry was started.`,
          )
        if (next.state === 'expired' || next.state === 'cancelled')
          throw new LocalPreviewError(
            `Local render interest ${next.state}. No matching rendered preview is available.`,
            true,
          )
        reply = next
      }
      const imageUrl = origin + localRenderImagePath(interest, reply.artifact.checksum)
      const png = await transport.fetch(imageUrl, { ...options, headers: { Accept: 'image/png' } })
      if (!active) return
      checkResponse(png, imageUrl, 'image/png')
      if (png.status !== 200) throw new LocalPreviewError('Local render PNG is unavailable.', true)
      const bytes = await readBytes(png, MAX_LOCAL_RENDER_PNG_BYTES, controller.signal)
      if (!active) return
      await validateLocalRenderImage(reply.artifact, bytes, async (snapshot) => {
        controller.signal.throwIfAborted()
        const dimensions = await transport.decode(snapshot, controller.signal)
        controller.signal.throwIfAborted()
        return dimensions
      })
      if (!active) return
      ownedUrl = transport.createObjectURL(new Blob([new Uint8Array(bytes)], { type: 'image/png' }))
      publish({ state: 'ready', reply, src: ownedUrl })
    } catch (error) {
      publish({
        state: error instanceof LocalPreviewError && error.unavailable ? 'unavailable' : 'error',
        message:
          error instanceof LocalPreviewError
            ? error.message
            : 'Local render identity, image bytes or decode could not be verified. No image was substituted. Operator review is required.',
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

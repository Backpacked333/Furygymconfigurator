import { parseDesign, type DesignEnvelope } from '../domain/design'
import {
  IMAGE_REQUEST_PATH,
  createImageRequest,
  createImageCancelRequest,
  imageStatusPath,
  imageCancelPath,
  imageErrorReplySchema,
  parseImageSubmissionReply,
  parseImageStatusReply,
  parseImageCancelReply,
  type ImageReadyReply,
  type MockArtifact,
} from '../image-service/protocol'

export const IMAGE_POLL_LIMIT = 20
export const IMAGE_DEADLINE_MS = 25_000
export type ImageProgress =
  | { state: 'pending' }
  | { state: 'ready'; reply: ImageReadyReply }
  | { state: 'error' | 'unavailable'; message: string; retryable: boolean }
export type ImageTransport = {
  fetch: typeof fetch
  decode: (artifact: MockArtifact, signal: AbortSignal) => Promise<void>
}

/** Decode complete bytes before presentation; never accept load-start as readiness. */
export function decodeMockImage(artifact: MockArtifact, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const image = new Image()
    const abort = () => finish(new Error('Preview decoding cancelled.'))
    let done = false
    function finish(error?: Error) {
      if (done) return
      done = true
      signal.removeEventListener('abort', abort)
      image.onload = image.onerror = null
      if (error) {
        image.src = ''
        reject(error)
      } else resolve()
    }
    if (signal.aborted) {
      abort()
      return
    }
    signal.addEventListener('abort', abort, { once: true })
    const decoded = () => {
      if (image.naturalWidth !== artifact.width || image.naturalHeight !== artifact.height)
        finish(new Error('Preview dimensions could not be verified.'))
      else finish()
    }
    if (typeof image.decode === 'function') {
      image.src = artifact.src
      void image.decode().then(decoded, () => finish(new Error('Preview decoding failed.')))
    } else {
      image.onload = decoded
      image.onerror = () => finish(new Error('Preview decoding failed.'))
      image.src = artifact.src
    }
  })
}

class PreviewError extends Error {
  constructor(
    message: string,
    readonly unavailable = false,
    readonly retryable = true,
  ) {
    super(message)
  }
}
async function responseBody(response: Response): Promise<unknown> {
  // Bounded body read, including responses that stream without Content-Length.
  if (!response.body) throw new PreviewError('The mock service returned no response body.')
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let text = '',
    size = 0
  try {
    while (true) {
      const part = await reader.read()
      if (part.done) break
      size += part.value.byteLength
      if (size > 32 * 1024) {
        await reader.cancel()
        throw new PreviewError('Mock response exceeded the safe size limit.', false, false)
      }
      text += decoder.decode(part.value, { stream: true })
    }
    text += decoder.decode()
  } finally {
    reader.releaseLock()
  }
  let input: unknown
  try {
    input = JSON.parse(text)
  } catch {
    throw new PreviewError('Mock service unavailable or returned an invalid response.', true)
  }
  if (!response.ok) {
    const error = imageErrorReplySchema.safeParse(input)
    if (error.success && error.data.error.code === 'capacity-exceeded')
      throw new PreviewError(
        'Mock capacity is exhausted (capacity-exceeded). Immediate retry will not free retained requests or restore synthetic budgets. Capacity needs time or operator review; editing, saving and exporting remain available.',
        true,
        false,
      )
    if (error.success)
      throw new PreviewError(
        `Mock preview unavailable (${error.data.error.code}).`,
        true,
        error.data.error.retryable,
      )
    throw new PreviewError('Mock service unavailable. No live or cloud fallback will start.', true)
  }
  return input
}

/**
 * One frozen revision/interest. Cleanup aborts local work AND attempts interest-only detach.
 * No automatic retries or fallback. Late replies may be detached but cannot publish progress.
 */
export function startImageRequest(
  inputDesign: DesignEnvelope,
  notify: (progress: ImageProgress) => void,
  transport: ImageTransport = { fetch: (...args) => fetch(...args), decode: decodeMockImage },
): () => void {
  // Snapshot before the admission delay: readonly types alone do not freeze a JS caller's input.
  const design = parseDesign(inputDesign)
  let active = true,
    interest: string | null = null,
    detached = false
  let waitTimer: ReturnType<typeof setTimeout> | undefined
  let stopWait: (() => void) | undefined
  const controller = new AbortController()
  const options = {
    credentials: 'same-origin',
    cache: 'no-store',
    signal: controller.signal,
  } as const
  const publish = (progress: ImageProgress) => {
    if (active) notify(progress)
  }
  function detach() {
    if (!interest || detached) return
    detached = true
    const id = interest
    const cancel = new AbortController()
    const timeout = setTimeout(() => cancel.abort(), 3000)
    void transport
      .fetch(imageCancelPath(id), {
        method: 'POST',
        credentials: 'same-origin',
        cache: 'no-store',
        keepalive: true,
        signal: cancel.signal,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(createImageCancelRequest(id)),
      })
      .then(async (response) => parseImageCancelReply(await responseBody(response), design, id))
      // Detach is best effort, never a claim of stopped shared work or provider cancellation.
      .catch(() => undefined)
      .finally(() => clearTimeout(timeout))
  }
  const deadline = setTimeout(() => {
    publish({
      state: 'unavailable',
      message: 'Mock preview timed out. Your design is safe; retry explicitly.',
      retryable: true,
    })
    active = false
    controller.abort()
    stopWait?.()
    detach()
  }, IMAGE_DEADLINE_MS)
  const wait = (ms: number) =>
    new Promise<void>((resolve) => {
      stopWait = resolve
      waitTimer = setTimeout(resolve, ms)
    })
  publish({ state: 'pending' })
  void (async () => {
    try {
      // Collapse rapid clicks before admission; controls/save/history never wait on this.
      await wait(120)
      if (!active) return
      const response = await transport.fetch(IMAGE_REQUEST_PATH, {
        ...options,
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(createImageRequest(design)),
      })
      let reply = (
        await parseImageSubmissionReply(response.status, await responseBody(response), design)
      ).body
      interest = reply.interestId
      if (!active) {
        detach()
        return
      }
      let polls = 0
      while (reply.state === 'queued' || reply.state === 'rendering') {
        if (polls++ >= IMAGE_POLL_LIMIT)
          throw new PreviewError('Mock preview polling limit reached. Retry explicitly.', true)
        await wait(Math.max(250, reply.retryAfterMs))
        if (!active) return
        const status = await transport.fetch(imageStatusPath(interest), options)
        if (status.status !== 200) {
          await responseBody(status)
          throw new PreviewError('Unexpected mock status response.')
        }
        const next = await parseImageStatusReply(await responseBody(status), design, interest)
        if (!active) return
        if (next.state === 'failed')
          throw new PreviewError(
            `Mock preview failed (${next.error.code}).`,
            false,
            next.error.retryable,
          )
        if (next.state === 'expired' || next.state === 'cancelled')
          throw new PreviewError(`Mock preview ${next.state}. Retry explicitly.`, true)
        reply = next
      }
      await transport.decode(reply.artifact, controller.signal)
      if (active) publish({ state: 'ready', reply })
    } catch (error) {
      if (active)
        publish({
          state: error instanceof PreviewError && error.unavailable ? 'unavailable' : 'error',
          message:
            error instanceof PreviewError
              ? error.message
              : 'Mock preview rejected or could not be decoded. No image was substituted.',
          retryable: error instanceof PreviewError ? error.retryable : true,
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
  }
}

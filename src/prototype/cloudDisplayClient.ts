import type { DesignEnvelope } from '../domain/design'
import { DISPLAY_LIMITS } from '../display/contract'
import {
  CLOUD_DISPLAY_PROTOCOL,
  CLOUD_DISPLAY_REQUEST_PATH,
  cloudArtifactSchema,
  cloudDisplayCancelPath,
  cloudDisplayErrorReplySchema,
  cloudDisplayImagePath,
  cloudDisplayStatusPath,
  createCloudDisplayRequest,
  parseCloudDisplayReply,
  type CloudDisplayReply,
  type CloudDisplayReadyReply,
  type CloudRecipe,
} from '../display/cloudContract'
import {
  DISPLAY_CLIENT_DEADLINE_MS,
  DISPLAY_CLIENT_POLL_LIMIT,
  DisplayClientError,
  checkResponse,
  createBoundedDisplaySelectionQueue,
  decodeDisplayImage,
  discard,
  localOrigin,
  readBytes,
  type DisplayTransport,
} from './displayClient'

// Public mode metadata belongs to the browser adapter; no private service imports reach the shell.
export { CLOUD_DISPLAY_LABEL, isCloudDisplaySelection } from '../display/cloudContract'

export type CloudDisplayProgress =
  | { state: 'pending' }
  | { state: 'ready'; reply: CloudDisplayReadyReply; src: string }
  | { state: 'error' | 'unavailable'; message: string; retryable: false }

export function createCloudDisplaySelectionQueue(start = startCloudDisplayRequest) {
  return createBoundedDisplaySelectionQueue<CloudDisplayProgress>(start)
}

/** Cloud provenance is validated directly, never stripped or converted to a local artifact. */
export async function validateCloudDisplayImage(
  artifact: CloudDisplayReadyReply['artifact'],
  input: Uint8Array,
  decode: (bytes: Uint8Array) => Promise<{ width: number; height: number }>,
) {
  const a = cloudArtifactSchema.parse(artifact)
  if (input.byteLength !== a.byteLength || input.byteLength > DISPLAY_LIMITS.pngBytes)
    throw new Error('Cloud display PNG byte cap/length mismatch.')
  const bytes = new Uint8Array(input)
  if (![137, 80, 78, 71, 13, 10, 26, 10].every((v, i) => bytes[i] === v))
    throw new Error('Cloud display requires PNG, not a diagnostic or historical substitution.')
  const header = new DataView(bytes.buffer)
  if (
    header.getUint32(8) !== 13 ||
    header.getUint32(12) !== 0x49484452 ||
    header.getUint32(16) !== a.width ||
    header.getUint32(20) !== a.height
  )
    throw new Error('Cloud display PNG header mismatch.')
  const hash = await globalThis.crypto.subtle.digest('SHA-256', bytes)
  const checksum = `sha256:${Array.from(new Uint8Array(hash), (b) => b.toString(16).padStart(2, '0')).join('')}`
  if (checksum !== a.checksum) throw new Error('Cloud display PNG checksum mismatch.')
  const decoded = await decode(bytes)
  if (decoded.width !== a.width || decoded.height !== a.height)
    throw new Error('Cloud display PNG decode mismatch.')
}

async function metadata(response: Response, url: string, signal: AbortSignal): Promise<unknown> {
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
    const parsed = cloudDisplayErrorReplySchema.safeParse(body)
    throw new DisplayClientError(
      parsed.success
        ? `Private cloud display unavailable (${parsed.data.error.code}${parsed.data.error.blocker ? `; ${parsed.data.error.blocker}` : ''}). Separate operator approval and runtime proof are required; no automatic retry or fallback.`
        : 'Private cloud display unavailable. No historical, mock or Lite image was substituted.',
      true,
    )
  }
  return body
}
function checkStatus(status: number, reply: CloudDisplayReply, submission = false) {
  const pending = reply.state === 'queued' || reply.state === 'rendering'
  if (status !== (pending ? 202 : 200) || (submission && !pending && reply.state !== 'ready'))
    throw new DisplayClientError('Cloud display HTTP status and image state disagree.')
}

/** Only a fixed authenticated DEV service route. No provider, execution options or auth bootstrap. */
export function startCloudDisplayRequest(
  inputDesign: DesignEnvelope,
  notify: (progress: CloudDisplayProgress) => void,
  transport: DisplayTransport = {
    origin: window.location.origin,
    fetch: (...args) => fetch(...args),
    decode: decodeDisplayImage,
    createObjectURL: (blob) => URL.createObjectURL(blob),
    revokeObjectURL: (url) => URL.revokeObjectURL(url),
  },
): () => void {
  let request: ReturnType<typeof createCloudDisplayRequest>, origin: string
  try {
    request = createCloudDisplayRequest(inputDesign)
    origin = localOrigin(transport.origin)
  } catch {
    notify({
      state: 'unavailable',
      message: 'Private cloud display requires a valid full design and a loopback DEV origin.',
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
  let expected: { interestId: string; recipe: CloudRecipe } | undefined
  let ownedUrl: string | undefined
  let waitTimer: ReturnType<typeof setTimeout> | undefined
  let stopWait: (() => void) | undefined
  const publish = (progress: CloudDisplayProgress) => {
    if (active) notify(progress)
  }
  const assertActive = () => {
    controller.signal.throwIfAborted()
    if (!active) throw new DOMException('Obsolete cloud display generation.', 'AbortError')
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
    const url = origin + cloudDisplayCancelPath(binding.interestId)
    void (async () => {
      try {
        const response = await transport.fetch(url, {
          ...options,
          signal: cancel.signal,
          method: 'POST',
          keepalive: true,
          headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
          body: JSON.stringify({ protocol: CLOUD_DISPLAY_PROTOCOL }),
        })
        if (cancel.signal.aborted) {
          discard(response)
          return
        }
        const body = await metadata(response, url, cancel.signal)
        cancel.signal.throwIfAborted()
        const reply = await parseCloudDisplayReply(body, design, binding)
        cancel.signal.throwIfAborted()
        if (response.status !== 200 || reply.state !== 'cancelled')
          throw new DisplayClientError('Invalid cloud interest cancellation reply.')
      } catch {
        // Detach only, not evidence of worker/provider termination or final billing.
      } finally {
        clearTimeout(timer)
      }
    })()
  }
  const deadline = setTimeout(() => {
    publish({
      state: 'unavailable',
      message:
        'Private cloud display wait expired. Shared work may continue; operator review is required. No image was substituted.',
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
      await wait(120)
      assertActive()
      const body = JSON.stringify(request)
      if (new TextEncoder().encode(body).byteLength > DISPLAY_LIMITS.requestBytes)
        throw new DisplayClientError('Cloud display request exceeded its byte cap.')
      const url = origin + CLOUD_DISPLAY_REQUEST_PATH
      const response = await transport.fetch(url, {
        ...options,
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body,
      })
      // A late admitted interest may only be validated and detached, never polled or displayed.
      const late = !active || controller.signal.aborted
      const cleanup = new AbortController()
      const cleanupTimer = setTimeout(() => cleanup.abort(), 3000)
      let reply: CloudDisplayReply
      try {
        const signal = late ? cleanup.signal : controller.signal
        const input = await metadata(response, url, signal)
        signal.throwIfAborted()
        reply = await parseCloudDisplayReply(input, design)
        expected = { interestId: reply.interestId, recipe: reply.recipe }
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
            'Cloud display polling cap reached; operator review required.',
            true,
          )
        await wait(Math.max(500, reply.retryAfterMs))
        assertActive()
        const statusUrl = origin + cloudDisplayStatusPath(expected.interestId)
        const response = await transport.fetch(statusUrl, {
          ...options,
          headers: { Accept: 'application/json' },
        })
        if (!active) {
          discard(response)
          return
        }
        assertActive()
        const input = await metadata(response, statusUrl, controller.signal)
        assertActive()
        reply = await parseCloudDisplayReply(input, design, expected)
        assertActive()
        checkStatus(response.status, reply)
      }
      if (reply.state === 'failed')
        throw new DisplayClientError(
          `Private cloud display failed (${reply.error.code}${reply.error.blocker ? `; ${reply.error.blocker}` : ''}). Operator review is required; no retry was started.`,
          reply.error.code === 'execution-denied' || reply.error.code === 'unavailable',
        )
      if (reply.state !== 'ready')
        throw new DisplayClientError(
          `Cloud display interest ${reply.state}. No matching image is available.`,
          true,
        )
      const imageUrl = origin + cloudDisplayImagePath(expected.interestId, reply.artifact.checksum)
      const png = await transport.fetch(imageUrl, { ...options, headers: { Accept: 'image/png' } })
      if (!active) {
        discard(png)
        return
      }
      assertActive()
      try {
        checkResponse(png, imageUrl, 'image/png')
        if (png.status !== 200) throw new DisplayClientError('Cloud display PNG unavailable.', true)
      } catch (error) {
        discard(png)
        throw error
      }
      const bytes = await readBytes(png, DISPLAY_LIMITS.pngBytes, controller.signal)
      assertActive()
      await validateCloudDisplayImage(reply.artifact, bytes, async (snapshot) => {
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
            : 'Private cloud display recipe, provenance, PNG bytes or decode could not be verified. No image was substituted; operator review is required.',
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

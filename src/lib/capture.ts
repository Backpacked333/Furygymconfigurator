import type { DeviceProfile } from '../render/quality'
import { samePresentation, type PresentationState, type PresentationToken } from './presentation'
export { presentationFrame } from './camera'

export type CaptureSize = { width: number; height: number }
export type CaptureRequest = CaptureSize & {
  token: PresentationToken
  mode: 'current' | 'presentation'
  framing: 'current' | 'center-crop'
  signal?: AbortSignal
  onProgress?: (phase: 'waiting' | 'rendering' | 'encoding', fraction: number) => void
}
export type CaptureResult =
  | {
      status: 'ready' | 'degraded'
      blob: Blob
      rendered: CaptureSize
      encoded: CaptureSize
      provenance: {
        token: PresentationToken
        framing: CaptureRequest['framing']
        mode: CaptureRequest['mode']
        transform: 'AgX/sRGB'
        native: true
      }
      reasons: readonly string[]
    }
  | {
      status: 'unavailable' | 'cancelled'
      reason: string
      alternatives?: CaptureSize[]
    }
export type CaptureProvider = {
  generation: number
  getState(): PresentationState
  subscribe(listener: () => void): () => void
  preflight(size: CaptureSize): CaptureCapability
  capture(request: CaptureRequest): Promise<CaptureResult>
}
export type CaptureRegistration = (provider: CaptureProvider) => void | (() => void)
export type CaptureCapability = {
  allowed: boolean
  reason?: string
  estimatedMB: number
  alternatives: CaptureSize[]
}
export const CAPTURE_TIMEOUT_MS = { current: 3000, presentation: 30000 } as const

export function captureCapability(
  size: CaptureSize,
  profile: DeviceProfile,
  bytesPerPixel = 128,
): CaptureCapability {
  const maxPixels =
    profile.hardware === 'capable'
      ? 3840 * 2160
      : profile.hardware === 'software' || profile.hardware === 'constrained'
        ? 1280 * 720
        : 1920 * 1080
  const valid =
    Number.isInteger(size.width) &&
    Number.isInteger(size.height) &&
    size.width > 0 &&
    size.height > 0
  const estimatedMB = valid ? (size.width * size.height * bytesPerPixel) / 1024 ** 2 : Infinity
  const fits = (s: CaptureSize) =>
    s.width > 0 &&
    s.height > 0 &&
    s.width <= profile.maxTextureSize &&
    s.height <= profile.maxTextureSize &&
    s.width * s.height <= maxPixels &&
    (s.width * s.height * bytesPerPixel) / 1024 ** 2 <= profile.memoryBudgetMB
  const aspect = valid ? size.width / size.height : 16 / 9
  const alternatives = [1920, 1280, 960]
    .map((edge) => {
      const width = Math.round(edge * Math.min(1, aspect))
      return { width, height: Math.max(1, Math.round(width / aspect)) }
    })
    .filter(
      (candidate) =>
        valid && candidate.width < size.width && candidate.height <= size.height && fits(candidate),
    )
  const allowed = valid && fits(size)
  if (valid && !allowed && !alternatives.length) {
    const pixelBudget = Math.min(maxPixels, (profile.memoryBudgetMB * 1024 ** 2) / bytesPerPixel)
    const width = Math.floor(
      Math.min(
        size.width - 1,
        profile.maxTextureSize,
        profile.maxTextureSize * aspect,
        Math.sqrt(pixelBudget * aspect),
      ),
    )
    for (const candidateWidth of [width, width - 1]) {
      const candidate = {
        width: candidateWidth,
        height: Math.max(1, Math.round(candidateWidth / aspect)),
      }
      if (fits(candidate)) {
        alternatives.push(candidate)
        break
      }
    }
  }
  return {
    allowed,
    estimatedMB,
    alternatives,
    reason: allowed
      ? undefined
      : 'Requested native render exceeds this device’s conservative capture budget.',
  }
}

export type CaptureTransaction = {
  frames: number
  render(): CaptureSize
  encode(): Promise<Blob | null>
  restore(): void
}
export type CaptureAdapter = {
  generation: number
  profile: DeviceProfile
  getState(): PresentationState
  subscribe(listener: () => void): () => void
  prepare(request: CaptureRequest): CaptureTransaction
  nextFrame(signal: AbortSignal): Promise<void>
}

function abortable<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => {
      cleanup()
      reject(new Error('Capture cancelled or timed out'))
    }
    const cleanup = () => signal.removeEventListener('abort', abort)
    signal.addEventListener('abort', abort, { once: true })
    work.then(
      (value) => {
        cleanup()
        resolve(value)
      },
      (error) => {
        cleanup()
        reject(error)
      },
    )
    if (signal.aborted) abort()
  })
}

async function pngSize(blob: Blob): Promise<CaptureSize> {
  const bytes = new Uint8Array(await blob.slice(0, 24).arrayBuffer())
  if (
    bytes.length !== 24 ||
    ![137, 80, 78, 71, 13, 10, 26, 10].every((v, i) => bytes[i] === v) ||
    ![73, 72, 68, 82].every((v, i) => bytes[i + 12] === v)
  )
    throw new Error('Invalid PNG header')
  const data = new DataView(bytes.buffer)
  return { width: data.getUint32(16), height: data.getUint32(20) }
}

export function createCaptureProvider(
  adapter: CaptureAdapter,
): CaptureProvider & { dispose(): void } {
  let disposed = false
  let active: AbortController | null = null
  let restoreActive: (() => void) | null = null
  const provider: CaptureProvider & { dispose(): void } = {
    generation: adapter.generation,
    getState: adapter.getState,
    subscribe: adapter.subscribe,
    preflight: (size) =>
      captureCapability(
        size,
        adapter.profile,
        adapter.getState().token.quality === 'ultra' ? 160 : 128,
      ),
    dispose() {
      disposed = true
      active?.abort()
      try {
        restoreActive?.()
      } catch {
        /* Teardown continues; the cancelled image is never accepted. */
      }
    },
    async capture(request) {
      request = { ...request, token: { ...request.token } }
      if (disposed)
        return { status: 'unavailable', reason: 'Renderer generation is no longer available.' }
      if (active) return { status: 'unavailable', reason: 'Another capture is in progress.' }
      const capability = provider.preflight(request)
      if (!capability.allowed)
        return {
          status: 'unavailable',
          reason: capability.reason!,
          alternatives: capability.alternatives,
        }
      const initial = adapter.getState()
      if (
        request.token.preview ||
        initial.token.preview ||
        initial.animating ||
        initial.token.view === 'plan'
      )
        return {
          status: 'unavailable',
          reason: 'Finish editing and pause motion in a 3D view before capturing.',
        }
      if (
        !samePresentation(request.token, initial.token) ||
        request.token.generation !== adapter.generation
      )
        return { status: 'cancelled', reason: 'Presentation changed before capture.' }
      if (
        request.mode === 'current' &&
        Math.abs(
          request.height - (request.width * initial.rendered.height) / initial.rendered.width,
        ) > 0.500001
      )
        return {
          status: 'unavailable',
          reason: 'Current-view capture must preserve the viewport aspect ratio.',
        }
      if (
        (request.mode === 'current' && request.framing !== 'current') ||
        (request.mode === 'presentation' && request.framing !== 'center-crop')
      )
        return {
          status: 'unavailable',
          reason: 'Choose the previewed framing policy for this capture mode.',
        }
      const controller = new AbortController()
      active = controller
      const abort = () => controller.abort()
      request.signal?.addEventListener('abort', abort, { once: true })
      if (request.signal?.aborted) abort()
      let timedOut = false
      const timer = setTimeout(() => {
        timedOut = true
        abort()
      }, CAPTURE_TIMEOUT_MS[request.mode])
      const stop = adapter.subscribe(() => {
        const state = adapter.getState()
        if (
          state.stage === 'lost' ||
          (restoreActive !== null && !['settled', 'degraded'].includes(state.stage)) ||
          state.animating ||
          !samePresentation(state.token, request.token)
        )
          abort()
      })
      let transaction: CaptureTransaction | undefined
      let result: CaptureResult
      const check = () => {
        const state = adapter.getState()
        if (
          disposed ||
          controller.signal.aborted ||
          state.stage === 'lost' ||
          state.animating ||
          !samePresentation(state.token, request.token)
        )
          throw new Error('Capture superseded')
      }
      try {
        check()
        request.onProgress?.('waiting', 0)
        check()
        if (!['settled', 'degraded'].includes(adapter.getState().stage)) {
          await abortable(
            new Promise<void>((resolve) => {
              const unsubscribe = adapter.subscribe(() => {
                if (['settled', 'degraded'].includes(adapter.getState().stage)) {
                  unsubscribe()
                  resolve()
                }
              })
              controller.signal.addEventListener('abort', unsubscribe, { once: true })
            }),
            controller.signal,
          )
        }
        check()
        const prepared = adapter.prepare(request)
        let restored = false
        transaction = {
          ...prepared,
          restore() {
            if (restored) return
            restored = true
            prepared.restore()
          },
        }
        restoreActive = transaction.restore
        let rendered: CaptureSize = { width: 0, height: 0 }
        for (let frame = 0; frame < transaction.frames; frame++) {
          check()
          request.onProgress?.('rendering', frame / transaction.frames)
          check()
          rendered = transaction.render()
          if (frame + 1 < transaction.frames)
            await abortable(adapter.nextFrame(controller.signal), controller.signal)
        }
        check()
        if (rendered.width !== request.width || rendered.height !== request.height)
          throw new Error('Native render dimensions did not match the request')
        request.onProgress?.('encoding', 1)
        check()
        const blob = await abortable(transaction.encode(), controller.signal)
        check()
        if (!blob || blob.size === 0 || blob.type !== 'image/png')
          throw new Error('PNG encoding failed')
        const encoded = await abortable(pngSize(blob), controller.signal)
        check()
        if (encoded.width !== rendered.width || encoded.height !== rendered.height)
          throw new Error('Encoded PNG dimensions did not match the native render')
        const state = adapter.getState()
        result = {
          status: state.stage === 'degraded' ? 'degraded' : 'ready',
          blob,
          rendered,
          encoded,
          reasons: state.reasons,
          provenance: {
            token: { ...request.token },
            framing: request.framing,
            mode: request.mode,
            transform: 'AgX/sRGB',
            native: true,
          },
        }
      } catch (error) {
        result = {
          status: controller.signal.aborted && !timedOut ? 'cancelled' : 'unavailable',
          reason: timedOut
            ? 'Capture exceeded its time budget. Try a lower resolution.'
            : error instanceof Error
              ? error.message
              : 'Capture failed.',
        }
      } finally {
        clearTimeout(timer)
        request.signal?.removeEventListener('abort', abort)
        stop()
        controller.abort()
        try {
          transaction?.restore()
        } catch {
          result = {
            status: 'unavailable',
            reason: 'Graphics restoration failed; the image was not accepted.',
          }
        }
        restoreActive = null
        active = null
      }
      return result!
    },
  }
  return provider
}

/** Stale generation cleanup cannot unregister a newer Canvas. */
export function createCaptureRegistry() {
  let current: CaptureProvider | null = null
  return {
    get: () => current,
    register(provider: CaptureProvider) {
      current = provider
      return () => {
        if (current === provider) current = null
      }
    },
  }
}

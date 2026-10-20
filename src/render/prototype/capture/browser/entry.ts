import {
  CAPTURE_LIMITS,
  CaptureContractError,
  WORKER_GLOBAL,
  type CaptureWorkerPage,
} from '../contract'
import { createCaptureWorker } from './control'

/** Runner-owned fixed URL only; no caller URL, arbitrary backend/settings or customer state. */
export function validatePrivateLocation(input: string) {
  const url = new URL(input)
  if (
    url.protocol !== 'http:' ||
    url.hostname !== '127.0.0.1' ||
    !url.port ||
    url.username ||
    url.password ||
    url.pathname !== '/worker.html' ||
    url.hash ||
    !['?renderer=webgl2', '?renderer=webgpu'].includes(url.search)
  )
    throw new CaptureContractError('network-denied', 'Private page location was not admitted.')
}

export async function bootstrapPrivatePage(): Promise<CaptureWorkerPage> {
  validatePrivateLocation(window.location.href)
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), CAPTURE_LIMITS.startupMs)
  try {
    const url = new URL('/__capture_bootstrap.json', window.location.origin)
    const response = await fetch(url, {
      redirect: 'error',
      cache: 'no-store',
      credentials: 'omit',
      signal: controller.signal,
    })
    if (
      !response.ok ||
      response.redirected ||
      response.url !== url.href ||
      response.headers.get('content-type')?.split(';')[0] !== 'application/json' ||
      !response.body
    )
      throw new CaptureContractError('identity-mismatch', 'Private bootstrap unavailable.')
    const reader = response.body.getReader()
    const chunks: Uint8Array[] = []
    let length = 0
    try {
      while (true) {
        const next = await reader.read()
        if (next.done) break
        length += next.value.byteLength
        if (length > CAPTURE_LIMITS.metadataBytes)
          throw new CaptureContractError('invalid-input', 'Private bootstrap exceeds byte bound.')
        chunks.push(next.value)
      }
    } finally {
      await reader.cancel().catch(() => {})
      reader.releaseLock()
    }
    if (controller.signal.aborted)
      throw new CaptureContractError('timeout', 'Bootstrap deadline elapsed.')
    const bytes = new Uint8Array(length)
    let offset = 0
    for (const chunk of chunks) {
      bytes.set(chunk, offset)
      offset += chunk.byteLength
    }
    const build: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))
    return createCaptureWorker(build, async (job, scope, progress) => {
      const scene = await scope.wait(import('./scene'))
      scope.check()
      return scene.renderScene(job, scope, progress)
    })
  } finally {
    clearTimeout(timeout)
  }
}

/** Installation kept separate so Node unit tests need neither DOM nor a graphics backend. */
export async function installPrivatePage() {
  const page = await bootstrapPrivatePage()
  Object.defineProperty(window, WORKER_GLOBAL, {
    value: page,
    writable: false,
    configurable: false,
  })
}

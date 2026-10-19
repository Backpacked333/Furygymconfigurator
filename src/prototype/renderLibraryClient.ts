import { parseDesign, type DesignEnvelope } from '../domain/design'
import {
  API_PATHS,
  CONTRACT_VERSION,
  lookupResponseSchema,
  sessionResponseSchema,
  type ImageDescriptor,
  type SetSnapshot,
} from '../render-library/contracts'
import {
  canonicalJson,
  computeSetIdentity,
  verifyImageDescriptor,
} from '../render-library/identity'
import { deliverImage, readBounded } from './imageDelivery'

const API_TIMEOUT_MS = 15_000
export function storageOrigins(): readonly string[] {
  const configured = import.meta.env.VITE_RENDER_LIBRARY_STORAGE_ORIGIN
  if (!configured) return []
  try {
    const url = new URL(configured)
    return url.protocol === 'https:' && url.origin === configured ? [url.origin] : []
  } catch {
    return []
  }
}

async function json(path: string, signal: AbortSignal, body?: unknown, csrf?: string) {
  if (!path.startsWith('/api/render-library/')) throw new Error('Invalid service path.')
  const controller = new AbortController()
  const abort = () => controller.abort()
  signal.throwIfAborted()
  signal.addEventListener('abort', abort, { once: true })
  const timeout = setTimeout(abort, API_TIMEOUT_MS)
  try {
    const response = await fetch(path, {
      method: body === undefined ? 'GET' : 'POST',
      credentials: 'same-origin',
      redirect: 'error',
      cache: 'no-store',
      signal: controller.signal,
      headers: {
        Accept: 'application/json',
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        ...(csrf ? { 'X-CSRF-Token': csrf } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    if (!response.headers.get('content-type')?.includes('application/json'))
      throw new Error('The image service is not available.')
    const value: unknown = JSON.parse(
      new TextDecoder().decode(await readBounded(response, 256 * 1024)),
    )
    if (!response.ok && lookupResponseSchema.safeParse(value).data?.status !== 'error')
      throw new Error('The image service is not available.')
    return value
  } finally {
    controller.abort()
    clearTimeout(timeout)
    signal.removeEventListener('abort', abort)
  }
}

export class LibraryRequestError extends Error {
  constructor(
    public code: string,
    message: string,
  ) {
    super(message)
  }
}

export async function verifySnapshot(value: unknown, design: DesignEnvelope): Promise<SetSnapshot> {
  const result = lookupResponseSchema.parse(value)
  if (result.status === 'error')
    throw new LibraryRequestError(result.error.code, result.error.message)
  const identity = await computeSetIdentity(design)
  if (canonicalJson(result.identity) !== canonicalJson(identity))
    throw new Error('Wrong image set.')
  await Promise.all(
    result.views.map(async (view) => {
      if (view.status === 'ready')
        await verifyImageDescriptor(
          view.image,
          parseDesign({
            ...design,
            presentation: { ...design.presentation, cameraRef: view.cameraRef },
          }),
          storageOrigins(),
        )
    }),
  )
  return result
}

export async function lookupSet(design: DesignEnvelope, signal: AbortSignal) {
  return verifySnapshot(
    await json(API_PATHS.lookup, signal, { contractVersion: CONTRACT_VERSION, design }),
    design,
  )
}
export async function readJob(jobId: string, design: DesignEnvelope, signal: AbortSignal) {
  return verifySnapshot(
    await json(`${API_PATHS.jobs}/${encodeURIComponent(jobId)}`, signal),
    design,
  )
}
export async function submitSet(
  design: DesignEnvelope,
  idempotencyKey: string,
  signal: AbortSignal,
  retryJobId?: string,
) {
  const session = sessionResponseSchema.parse(await json(API_PATHS.session, signal))
  if (Date.parse(session.expiresAt) <= Date.now())
    throw new LibraryRequestError(
      'csrf-invalid',
      'Your render session has expired. Check status before trying again.',
    )
  const body = retryJobId
    ? { contractVersion: CONTRACT_VERSION, intent: 'retry-failed-missing', idempotencyKey }
    : { contractVersion: CONTRACT_VERSION, design, intent: 'render-missing', idempotencyKey }
  const path = retryJobId
    ? `${API_PATHS.jobs}/${encodeURIComponent(retryJobId)}/retry`
    : API_PATHS.jobs
  return verifySnapshot(await json(path, signal, body, session.csrfToken), design)
}

export async function decodeLibraryImage(
  image: ImageDescriptor,
  design: DesignEnvelope,
  signal: AbortSignal,
) {
  const verified = await verifyImageDescriptor(image, design, storageOrigins())
  signal.throwIfAborted()
  return deliverImage(verified, signal)
}

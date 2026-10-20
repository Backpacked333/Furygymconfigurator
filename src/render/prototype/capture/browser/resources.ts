import { TEXTURE_SETS, loadedMaps, type TextureSet } from '../../../materials'
import { FIELD_DIMS, type SiteLightField } from '../../../siteLight'
import { CaptureContractError, CAPTURE_LIMITS } from '../contract'
import type { CaptureScope, SettleGate } from './control'

const texturePaths = new Map<string, TextureSet>()
for (const [set, options] of Object.entries(TEXTURE_SETS)) {
  for (const map of 'detailOnly' in options ? ['normal', 'arm'] : ['albedo', 'normal', 'arm'])
    texturePaths.set(`/textures/${set}/${map}.webp`, set as TextureSet)
}

/** Browser-side narrowing only. Runner must hash/exact-allowlist all actual emitted assets. */
export function admittedResource(input: string, origin: string, kind: 'texture' | 'worker') {
  const url = new URL(input, `${origin}/`)
  if (
    url.origin !== origin ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    (input !== url.href && input !== url.pathname) ||
    /[%\\]/.test(input)
  )
    throw new CaptureContractError('network-denied', 'Only canonical local resources are allowed.')
  if (
    kind === 'texture'
      ? !texturePaths.has(url.pathname)
      : !/^\/assets\/siteLight\.worker-[A-Za-z0-9_-]+\.js$/.test(url.pathname)
  )
    throw new CaptureContractError('network-denied', 'Unexpected private resource.')
  return url
}

export function validSiteField(value: unknown): value is SiteLightField {
  if (!value || typeof value !== 'object') return false
  const field = value as SiteLightField
  const finite = (v: unknown, n: number) =>
    Array.isArray(v) && v.length === n && v.every(Number.isFinite)
  return (
    finite(field.origin, 3) &&
    finite(field.cell, 3) &&
    field.cell.every((v) => v > 0) &&
    finite(field.dims, 3) &&
    field.dims.every((v, i) => v === FIELD_DIMS[i]) &&
    finite(field.capture, 4) &&
    field.values instanceof Float32Array &&
    field.values.length === FIELD_DIMS.reduce((a, b) => a * b, 4) &&
    field.values.every(Number.isFinite)
  )
}

/** Installed only in a fresh private page, before any scene mounts. It is never a public API. */
export function guardResources(scope: CaptureScope, gate: SettleGate) {
  const origin = window.location.origin
  const nativeFetch = window.fetch.bind(window)
  const NativeWorker = window.Worker
  const nativeSetTimeout = window.setTimeout.bind(window)
  const nativeClearTimeout = window.clearTimeout.bind(window)
  const timers = new Set<number>()
  const workers = new Set<Worker>()
  const requested = new Set<TextureSet>()
  let failure: CaptureContractError | undefined
  let closed = false
  let requests = 0
  let bytes = 0
  let pending = 0
  const fail = (
    code: 'asset-failed' | 'network-denied' | 'limit-exceeded' | 'scene-failed',
    message = 'Private resource readiness failed.',
  ) => {
    failure ??= new CaptureContractError(code, message)
    return failure
  }
  const check = () => {
    scope.check()
    if (failure) throw failure
    if (closed) throw new CaptureContractError('cancelled', 'Resources were released.')
  }
  // Includes inherited loader retries/debounce timers. After disposal, late loader continuations
  // cannot create fresh retry timers. This single-use realm is intentionally never restored.
  window.setTimeout = ((handler: TimerHandler, ms?: number, ...args: unknown[]) => {
    if (closed) return 0
    if (typeof handler !== 'function') throw fail('network-denied')
    const id = nativeSetTimeout(() => {
      timers.delete(id)
      if (!closed) {
        try {
          handler(...args)
        } catch {
          fail('scene-failed', 'Private timer callback failed.')
        }
      }
    }, ms)
    timers.add(id)
    return id
  }) as typeof window.setTimeout
  window.clearTimeout = (id) => {
    if (typeof id === 'number') timers.delete(id)
    nativeClearTimeout(id)
  }
  window.fetch = async (input, init) => {
    check()
    if (!(typeof input === 'string' || input instanceof URL) || init !== undefined)
      throw fail('network-denied')
    let url: URL
    try {
      url = admittedResource(String(input), origin, 'texture')
    } catch {
      throw fail('network-denied')
    }
    if (++requests > CAPTURE_LIMITS.resourceRequests) throw fail('limit-exceeded')
    requested.add(texturePaths.get(url.pathname)!)
    pending++
    gate.changed(performance.now())
    try {
      const response = await scope.wait(
        nativeFetch(url.href, {
          redirect: 'error',
          credentials: 'omit',
          cache: 'no-store',
          signal: scope.signal,
        }),
      )
      check()
      if (
        !response.ok ||
        response.redirected ||
        response.url !== url.href ||
        response.headers.get('content-type')?.split(';')[0] !== 'image/webp' ||
        !response.body
      )
        throw fail('asset-failed')
      const reader = response.body.getReader()
      const chunks: Uint8Array<ArrayBuffer>[] = []
      let length = 0
      try {
        while (true) {
          const next = await scope.wait(reader.read())
          check()
          if (next.done) break
          length += next.value.byteLength
          bytes += next.value.byteLength
          if (length > CAPTURE_LIMITS.assetBytes || bytes > CAPTURE_LIMITS.totalAssetBytes)
            throw fail('limit-exceeded')
          chunks.push(new Uint8Array(next.value))
        }
      } finally {
        await reader.cancel().catch(() => {})
        reader.releaseLock()
      }
      check()
      if (length === 0) throw fail('asset-failed')
      return new Response(new Blob(chunks, { type: 'image/webp' }), { status: 200 })
    } catch (error) {
      if (error instanceof CaptureContractError) throw error
      throw fail('asset-failed')
    } finally {
      pending--
      gate.changed(performance.now())
    }
  }
  // The only authored worker is the site irradiance field. Its completion is observed instead
  // of assuming a fixed frame count means its Float32 data arrived and was applied.
  window.Worker = class extends NativeWorker {
    constructor(input: string | URL, options?: WorkerOptions) {
      check()
      let url: URL
      try {
        url = admittedResource(String(input), origin, 'worker')
      } catch {
        throw fail('network-denied')
      }
      if (
        workers.size !== 0 ||
        options?.type !== 'module' ||
        Object.keys(options).some((key) => key !== 'type')
      )
        throw fail('network-denied')
      if (++requests > CAPTURE_LIMITS.resourceRequests) throw fail('limit-exceeded')
      try {
        super(url, options)
      } catch {
        throw fail('scene-failed', 'Private site worker failed.')
      }
      workers.add(this)
      this.addEventListener('error', () => fail('scene-failed', 'Private site worker failed.'))
      this.addEventListener('messageerror', () =>
        fail('scene-failed', 'Private site worker message failed.'),
      )
      this.addEventListener('message', (event: MessageEvent) => {
        if (closed) return
        if (event.data?.id !== 1 || !validSiteField(event.data.field)) {
          fail('scene-failed', 'Private site field was invalid.')
          return
        }
        // The authored listener resolves its promise in this event; its setSiteField microtask
        // runs before our next timer-driven frame. A further 500ms quiet + two frames is required.
        gate.siteField = true
        gate.changed(performance.now())
      })
    }
  }
  scope.own(() => {
    closed = true
    workers.forEach((worker) => worker.terminate())
    timers.forEach(nativeClearTimeout)
    timers.clear()
  })
  return {
    check,
    materialsReady() {
      check()
      return pending === 0 && requested.size > 0 && [...requested].every((set) => !!loadedMaps(set))
    },
    maps: () => [...requested].flatMap((set) => Object.values(loadedMaps(set) ?? {})),
  }
}

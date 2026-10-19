import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { defaultDesign, projectDesignToConfig } from '../../domain/design'
import { FIELD_DIMS, type SiteLightField } from '../siteLight'
import {
  disposePrivateSiteFieldWorker,
  requestSiteField,
  validPrivateSiteField,
} from '../siteLightNode'

class InertWorker extends EventTarget {
  static current: InertWorker
  messages: { id: number }[] = []
  terminated = false
  constructor() {
    super()
    InertWorker.current = this
  }
  postMessage(value: { id: number }) {
    this.messages.push(value)
  }
  terminate() {
    this.terminated = true
  }
  answer(id: number, field: unknown) {
    this.dispatchEvent(new MessageEvent('message', { data: { id, field } }))
  }
}
const design = projectDesignToConfig(defaultDesign())
function field(): SiteLightField {
  return {
    origin: [0, 0, 0],
    cell: [1, 1, 1],
    dims: [...FIELD_DIMS],
    capture: [1, 0, 0, 0],
    values: new Float32Array(FIELD_DIMS.reduce((a, b) => a * b, 4)),
  }
}
beforeEach(() => vi.stubGlobal('Worker', InertWorker))
afterEach(() => {
  disposePrivateSiteFieldWorker()
  vi.unstubAllGlobals()
})
describe('opt-in site-field tickets (inert event targets; no actual worker or GPU)', () => {
  it('rejects stale tickets after abort and resolves only the current request on the reused worker', async () => {
    const old = new AbortController(),
      current = new AbortController()
    const a = requestSiteField(design, old.signal),
      worker = InertWorker.current
    const rejected = expect(a).rejects.toThrow('cancelled')
    old.abort()
    await rejected
    let completed = false
    const b = requestSiteField({ ...design, time: 20.5 }, current.signal).then((v) => {
      completed = true
      return v
    })
    expect(InertWorker.current).toBe(worker)
    worker.answer(worker.messages[0].id, field())
    await Promise.resolve()
    expect(completed).toBe(false)
    const value = field()
    worker.answer(worker.messages[1].id, value)
    expect(await b).toBe(value)
  })
  it('explicitly resolves studio null-field and rejects malformed or failed private work', async () => {
    await expect(
      requestSiteField({ ...design, environment: 'studio' }, new AbortController().signal),
    ).resolves.toBeNull()
    const a = requestSiteField(design, new AbortController().signal),
      worker = InertWorker.current
    worker.answer(worker.messages[0].id, { values: [] })
    await expect(a).rejects.toThrow('Invalid')
    const b = requestSiteField(design, new AbortController().signal)
    worker.dispatchEvent(new Event('error'))
    await expect(b).rejects.toThrow('worker failed')
  })
  it('strict private work has no synchronous missing-worker fallback and teardown terminates ownership', async () => {
    vi.stubGlobal(
      'Worker',
      class {
        constructor() {
          throw new Error('Worker unavailable')
        }
      },
    )
    await expect(requestSiteField(design, new AbortController().signal)).rejects.toThrow(
      'requires its owned worker',
    )
    disposePrivateSiteFieldWorker()
    vi.stubGlobal('Worker', InertWorker)
    const controller = new AbortController(),
      pending = requestSiteField(design, controller.signal)
    const rejected = expect(pending).rejects.toThrow('cancelled')
    controller.abort()
    await rejected
    const worker = InertWorker.current
    disposePrivateSiteFieldWorker()
    expect(worker.terminated).toBe(true)
  })
  it('validates finite exact-sized field data rather than trusting a received flag', () => {
    expect(validPrivateSiteField(field())).toBe(true)
    expect(validPrivateSiteField({ ...field(), dims: [1, 1, 1] })).toBe(false)
    const bad = field()
    bad.values[0] = NaN
    expect(validPrivateSiteField(bad)).toBe(false)
  })
})

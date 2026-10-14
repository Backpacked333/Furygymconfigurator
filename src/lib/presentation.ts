import type { Quality } from '../render/quality'

export type PresentationToken = {
  revision: number
  generation: number
  view: 'exterior' | 'interior' | 'plan'
  camera: string
  material: string
  presentation: string
  quality: Quality
  preview: boolean
}
export type PresentationStage =
  'initializing' | 'interactive' | 'refining' | 'settled' | 'degraded' | 'lost'
export type PresentationState = {
  token: PresentationToken
  stage: PresentationStage
  reasons: readonly string[]
  animating: boolean
  rendered: { width: number; height: number }
  display?: { width: number; height: number; dpr: number }
}
export type AssetReadiness = { pending: number; degraded: boolean; revision: string }

export function samePresentation(a: PresentationToken, b: PresentationToken) {
  return (
    a.revision === b.revision &&
    a.generation === b.generation &&
    a.view === b.view &&
    a.camera === b.camera &&
    a.material === b.material &&
    a.presentation === b.presentation &&
    a.quality === b.quality &&
    a.preview === b.preview
  )
}

export function createPresentationStore(initial: PresentationState) {
  let state = initial
  const listeners = new Set<() => void>()
  return {
    get: () => state,
    set(next: PresentationState) {
      state = next
      listeners.forEach((listener) => listener())
    },
    subscribe(listener: () => void) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    capturing: false,
    probePending: true,
    reset: () => {},
  }
}
export type PresentationStore = ReturnType<typeof createPresentationStore>

/** Own only allocations made here, never borrowed scene geometry/materials. */
export function createDisposalScope() {
  const owned: { dispose(): void }[] = []
  let disposed = false
  return {
    own<T extends { dispose(): void }>(resource: T): T {
      if (disposed) throw new Error('Resource scope is disposed')
      if (!owned.includes(resource)) owned.push(resource)
      return resource
    },
    dispose() {
      if (disposed) return
      disposed = true
      const errors: unknown[] = []
      for (const resource of owned.reverse()) {
        try {
          resource.dispose()
        } catch (error) {
          errors.push(error)
        }
      }
      owned.length = 0
      if (errors.length) throw new AggregateError(errors, 'Resource cleanup failed')
    },
  }
}

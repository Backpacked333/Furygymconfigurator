/** Shell-safe asset readiness. No renderer imports, timers, or historical request counters. */
export type AssetStatus = 'pending' | 'ready' | 'failed' | 'degraded'
export type AssetMapState = {
  id: string
  set: string
  role: 'albedo' | 'normal' | 'arm'
  status: AssetStatus
  source: 'pending' | 'ready' | 'failed'
  render: 'fallback' | 'ready'
  attempts: number
  maxAttempts: number
  error?: string
}
export type AssetSnapshot = {
  generation: number
  revision: number
  owners: number
  requested: number
  /** Terminal outcomes, including fallback, for legacy progress bars. See `ready` for success. */
  loaded: number
  pending: number
  ready: number
  failed: number
  degraded: number
  settled: boolean
  canRetry: boolean
  maps: readonly AssetMapState[]
}
type Listener = () => void
type Owner = { generation: number; maps: readonly AssetMapState[]; retry: () => void }

export function createTextureProgress() {
  const listeners = new Set<Listener>()
  const owners = new Map<string, Owner>()
  const snapshots = new Map<string, AssetSnapshot>()
  let generation = 0
  let revision = 0
  function summarize(selected: Owner[]): AssetSnapshot {
    const maps = [...new Map(selected.flatMap((o) => o.maps).map((m) => [m.id, m])).values()]
    const pending = maps.filter((m) => m.source === 'pending').length
    return {
      generation,
      revision,
      owners: selected.length,
      requested: maps.length,
      loaded: maps.length - pending,
      pending,
      ready: maps.filter((m) => m.status === 'ready').length,
      failed: maps.filter((m) => m.source === 'failed').length,
      degraded: maps.filter((m) => m.status === 'degraded').length,
      settled: pending === 0,
      canRetry: maps.some((m) => m.source === 'failed' && m.attempts < m.maxAttempts),
      maps,
    }
  }
  let snapshot = summarize([])
  let legacySnapshot = { requested: 0, loaded: 0 }
  let empty = snapshot
  function publish() {
    revision++
    const active = [...owners.entries()].filter(([, o]) => o.generation === generation)
    snapshot = summarize(active.map(([, o]) => o))
    legacySnapshot = { requested: snapshot.requested, loaded: snapshot.loaded }
    empty = summarize([])
    snapshots.clear()
    const scopes = new Map<string, Owner[]>()
    active.forEach(([id, owner]) => {
      const segments = id.split(':')
      for (let i = 1; i <= segments.length; i++) {
        const scope = segments.slice(0, i).join(':')
        const selected = scopes.get(scope) ?? []
        selected.push(owner)
        scopes.set(scope, selected)
      }
    })
    scopes.forEach((selected, scope) => snapshots.set(scope, summarize(selected)))
    listeners.forEach((listener) => listener())
  }
  return {
    subscribe(listener: Listener) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    get: () => legacySnapshot,
    snapshot: (ownerId?: string) => (ownerId ? (snapshots.get(ownerId) ?? empty) : snapshot),
    setGeneration(value: number) {
      if (generation === value) return
      generation = value
      publish()
    },
    register(id: string, ownerGeneration: number, retry: () => void) {
      const owner: Owner = { generation: ownerGeneration, maps: [], retry }
      owners.set(id, owner)
      publish()
      return {
        update(maps: readonly AssetMapState[]) {
          if (owners.get(id) !== owner) return
          owner.maps = maps
          publish()
        },
        dispose() {
          if (owners.get(id) !== owner) return
          owners.delete(id)
          publish()
        },
      }
    },
    retry(ownerId?: string) {
      const selected = [...owners.entries()]
        .filter(([id]) => !ownerId || id === ownerId || id.startsWith(`${ownerId}:`))
        .map(([, owner]) => owner)
      selected.forEach((owner) => {
        if (owner?.generation === generation) owner.retry()
      })
    },
    /** Compatibility for external legacy loaders; never included in scoped readiness. */
    update(requested: number, loaded: number) {
      const id = 'legacy'
      const previous = owners.get(id)?.maps ?? []
      const maps = [...previous]
      for (let i = 0; i < requested; i++)
        maps.push({
          id: `legacy:${maps.length}`,
          set: 'legacy',
          role: 'albedo',
          status: 'pending',
          source: 'pending',
          render: 'fallback',
          attempts: 1,
          maxAttempts: 1,
        })
      for (let i = 0; i < maps.length && loaded > 0; i++) {
        if (maps[i].status === 'pending') {
          maps[i] = { ...maps[i], status: 'ready', source: 'ready', render: 'ready' }
          loaded--
        }
      }
      owners.set(id, { generation, maps, retry: () => {} })
      publish()
    },
  }
}

export const textureProgress = createTextureProgress()

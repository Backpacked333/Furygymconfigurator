/** Load progress of the material library, observable without importing three.js. */
type Listener = () => void
const listeners = new Set<Listener>()
let snapshot = { requested: 0, loaded: 0 }

export const textureProgress = {
  subscribe(listener: Listener) {
    listeners.add(listener)
    return () => {
      listeners.delete(listener)
    }
  },
  get: () => snapshot,
  /** Called by the material library as maps are requested and arrive. */
  update(requested: number, loaded: number) {
    snapshot = { requested: snapshot.requested + requested, loaded: snapshot.loaded + loaded }
    listeners.forEach((listener) => listener())
  },
}

/** Where the 3D view is on its way to a first picture. */
export type ScenePhase = 'engine' | 'renderer' | 'shaders' | 'ready'
const phaseListeners = new Set<Listener>()
let phase: ScenePhase = 'engine'
let afterDraw: (() => void)[] = []

export const sceneProgress = {
  subscribe(listener: Listener) {
    phaseListeners.add(listener)
    return () => {
      phaseListeners.delete(listener)
    }
  },
  get: () => phase,
  set(next: ScenePhase) {
    if (phase === next) return
    phase = next
    phaseListeners.forEach((listener) => listener())
  },
  /** Runs `callback` once, after the next frame the scene draws. */
  afterNextDraw(callback: () => void) {
    afterDraw.push(callback)
    return () => {
      afterDraw = afterDraw.filter((c) => c !== callback)
    }
  },
  /** Called by the scene each time it draws a frame. */
  drawn() {
    sceneProgress.set('ready')
    if (!afterDraw.length) return
    const callbacks = afterDraw
    afterDraw = []
    callbacks.forEach((callback) => callback())
  },
}

/**
 * Asynchronous scene work that changes the picture after it arrives (the ground scan, interior
 * probe captures). A still is only captured once nothing is outstanding.
 */
const outstanding = new Set<string>()
export const sceneWork = {
  set(id: string, busy: boolean) {
    if (busy) outstanding.add(id)
    else outstanding.delete(id)
  },
  idle: () => outstanding.size === 0,
  pending: () => [...outstanding],
}

/**
 * What changed in the scene outside React's render: streamed textures, a light probe capture, an
 * environment map. The render loop redraws for each, but only `content` restarts convergence;
 * the others arrive mid-settle and simply extend it.
 */
export type SceneChange = 'content' | 'textures' | 'probe' | 'environment'
const changeListeners = new Set<(change: SceneChange) => void>()
export const sceneChanges = {
  subscribe(listener: (change: SceneChange) => void) {
    changeListeners.add(listener)
    return () => {
      changeListeners.delete(listener)
    }
  },
  notify(change: SceneChange) {
    changeListeners.forEach((listener) => listener(change))
  },
}

/**
 * Whether the frame being drawn is a motion frame. Costly extras that can lag a moment (planar
 * reflections, secondary views) skip their update while it is true and catch up at rest.
 */
export const viewerMotion = { active: false }

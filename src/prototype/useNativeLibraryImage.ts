import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { parseDesign, serializeDesign, type DesignEnvelope } from '../domain/design'
import type { ImageDescriptor } from '../render-library/contracts'
import { decodeLibraryImage } from './renderLibraryClient'
import { useLibrarySet } from './useLibrarySet'
import {
  decodeNativeImage,
  findNativeImage,
  getNativeLibrary,
  type NativeEntry,
  type NativeLibrary,
} from './nativeLibrary'

export type NativeReply = { mode: 'native-library'; artifact: NativeEntry | ImageDescriptor }
type NativeProgress =
  | { state: 'pending' }
  | { state: 'ready'; reply: NativeReply; src: string }
  | { state: 'unavailable' | 'error'; message: string; retryable: boolean }
type ShownImage = {
  key: string
  reply: NativeReply
  src: string
  aspect: DesignEnvelope['presentation']['aspect']
  release: () => void
}
type Snapshot = {
  generation: number
  progress: NativeProgress
  shown: ShownImage | null
  previous: ShownImage | null
}
export function useNativeCatalog(enabled = true) {
  const [library, setLibrary] = useState<NativeLibrary | null>(null)
  useEffect(() => {
    if (!enabled) return
    let active = true
    void getNativeLibrary()
      .then((value) => {
        if (active) setLibrary(value)
      })
      .catch(() => undefined)
    return () => {
      active = false
    }
  }, [enabled])
  return library
}

export function useNativeLibraryImage(design: DesignEnvelope) {
  const library = useLibrarySet(design)
  const view = library.snapshot?.views.find(
    (view) => view.cameraRef === design.presentation.cameraRef,
  )
  const dynamic = view?.status === 'ready' ? view.image : undefined
  const lookupPending = library.checking && !library.snapshot
  const dynamicRef = useRef(dynamic)
  dynamicRef.current = dynamic
  const key = serializeDesign(design)
  const [selection, setSelection] = useState({ key, generation: 0 })
  const [attempt, retry] = useState(0)
  if (selection.key !== key) setSelection({ key, generation: selection.generation + 1 })
  const { generation } = selection
  const active = useRef(0)
  const delivered = useRef<{ generation: number; attempt: number } | null>(null)
  const held = useRef<{ shown: ShownImage | null; previous: ShownImage | null }>({
    shown: null,
    previous: null,
  })
  const fadeTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const queued = useRef<{ show: () => void; release: () => void } | null>(null)
  const [snapshot, setSnapshot] = useState<Snapshot>({
    generation: -1,
    progress: { state: 'pending' },
    shown: null,
    previous: null,
  })
  const finishTransition = useCallback((src: string) => {
    if (held.current.shown?.src !== src) return
    clearTimeout(fadeTimer.current)
    held.current.previous?.release()
    held.current.previous = null
    setSnapshot((value) => ({ ...value, previous: null }))
    const next = queued.current
    queued.current = null
    next?.show()
  }, [])
  useLayoutEffect(
    () => () => {
      clearTimeout(fadeTimer.current)
      queued.current?.release()
      queued.current = null
      held.current.previous?.release()
      held.current.shown?.release()
      held.current = { shown: null, previous: null }
    },
    [],
  )
  useLayoutEffect(() => {
    const design = parseDesign(JSON.parse(key))
    const token = ++active.current
    const controller = new AbortController()
    queued.current?.release()
    queued.current = null
    const descriptor = dynamicRef.current
    const artifact = held.current.shown?.reply.artifact
    const shownHash = artifact && ('sha256' in artifact ? artifact.sha256 : artifact.imageSha256)
    if (
      delivered.current?.generation === generation &&
      delivered.current.attempt === attempt &&
      held.current.shown?.key === key &&
      (!descriptor || descriptor.sha256 === shownHash)
    )
      return
    const update = (progress: NativeProgress, release: () => void = () => {}) => {
      if (active.current !== token || controller.signal.aborted) {
        release()
        return
      }
      delivered.current = progress.state === 'ready' ? { generation, attempt } : null
      const retained = held.current
      // Finish the visible blend before starting another; never snap a half-faded layer opaque.
      if (progress.state === 'ready' && retained.previous) {
        queued.current?.release()
        queued.current = { show: () => update(progress, release), release }
        return
      }
      if (progress.state === 'ready') {
        const old = retained.shown
        const animate =
          old &&
          old.src !== progress.src &&
          old.aspect === design.presentation.aspect &&
          !window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
        if (animate) retained.previous = old
        else old?.release()
        retained.shown = {
          key,
          src: progress.src,
          reply: progress.reply,
          aspect: design.presentation.aspect,
          release,
        }
        if (animate) fadeTimer.current = setTimeout(() => finishTransition(progress.src), 800)
      } else if (
        progress.state !== 'pending' ||
        retained.shown?.aspect !== design.presentation.aspect
      ) {
        clearTimeout(fadeTimer.current)
        retained.previous?.release()
        retained.previous = null
        retained.shown?.release()
        retained.shown = null
      }
      setSnapshot({ generation, progress, ...retained })
    }
    update({ state: 'pending' })
    void (async () => {
      if (descriptor) {
        const decoded = await decodeLibraryImage(descriptor, design, controller.signal)
        if (controller.signal.aborted) {
          decoded.release()
          return
        }
        update(
          {
            state: 'ready',
            reply: { mode: 'native-library', artifact: descriptor },
            src: decoded.src,
          },
          decoded.release,
        )
        return
      }
      const catalog = await getNativeLibrary().catch(() => null)
      if (controller.signal.aborted) return
      const entry = catalog ? findNativeImage(catalog, design) : undefined
      if (!entry) {
        if (lookupPending) return
        update({
          state: 'unavailable',
          retryable: false,
          message: 'No verified image is available for this selected view. No substitute is shown.',
        })
        return
      }
      const decoded = await decodeNativeImage(entry, controller.signal)
      if (controller.signal.aborted) {
        decoded.release?.()
        return
      }
      update(
        {
          state: 'ready',
          reply: { mode: 'native-library', artifact: entry },
          src: decoded.src,
        },
        decoded.release,
      )
    })().catch((error: unknown) =>
      update({
        state: 'error',
        retryable: true,
        message:
          error instanceof Error
            ? 'The selected image could not be verified or delivered. Retry image delivery; this never starts a render.'
            : 'The image could not be loaded.',
      }),
    )
    return () => {
      active.current = token + 1
      controller.abort()
    }
  }, [key, generation, attempt, dynamic?.sha256, lookupPending, finishTransition])
  const progress: NativeProgress =
    snapshot.generation === generation && selection.key === key
      ? snapshot.progress
      : { state: 'pending' }
  return {
    progress,
    shown: snapshot.shown,
    previous: snapshot.previous,
    finishTransition,
    current: snapshot.shown?.key === key && progress.state === 'ready',
    retry: () => retry((value) => value + 1),
    library,
  }
}

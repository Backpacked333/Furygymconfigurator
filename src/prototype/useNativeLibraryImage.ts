import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { serializeDesign, type DesignEnvelope } from '../domain/design'
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
type Snapshot = {
  generation: number
  progress: NativeProgress
  shown: { key: string; reply: NativeReply; src: string } | null
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
  const dynamicRef = useRef(dynamic)
  dynamicRef.current = dynamic
  const key = serializeDesign(design)
  const [selection, setSelection] = useState({ key, generation: 0 })
  const [attempt, retry] = useState(0)
  if (selection.key !== key) setSelection({ key, generation: selection.generation + 1 })
  const { generation } = selection
  const active = useRef(0)
  const [snapshot, setSnapshot] = useState<Snapshot>({
    generation: -1,
    progress: { state: 'pending' },
    shown: null,
  })
  useLayoutEffect(() => {
    const token = ++active.current
    const controller = new AbortController()
    let release: (() => void) | undefined
    const update = (progress: NativeProgress) => {
      if (active.current !== token || controller.signal.aborted) return
      setSnapshot({
        generation,
        progress,
        shown:
          progress.state === 'ready' ? { key, reply: progress.reply, src: progress.src } : null,
      })
    }
    update({ state: 'pending' })
    void (async () => {
      const descriptor = dynamicRef.current
      if (descriptor) {
        const decoded = await decodeLibraryImage(descriptor, design, controller.signal)
        if (controller.signal.aborted) {
          decoded.release()
          return
        }
        release = decoded.release
        update({
          state: 'ready',
          reply: { mode: 'native-library', artifact: descriptor },
          src: decoded.src,
        })
        return
      }
      const catalog = await getNativeLibrary().catch(() => null)
      if (controller.signal.aborted) return
      const entry = catalog ? findNativeImage(catalog, design) : undefined
      if (!entry) {
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
      release = decoded.release
      update({
        state: 'ready',
        reply: { mode: 'native-library', artifact: entry },
        src: decoded.src,
      })
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
      release?.()
    }
  }, [design, key, generation, attempt, dynamic?.sha256])
  const progress: NativeProgress =
    snapshot.generation === generation && selection.key === key
      ? snapshot.progress
      : { state: 'pending' }
  return {
    progress,
    shown: snapshot.shown,
    current: snapshot.shown?.key === key && progress.state === 'ready',
    retry: () => retry((value) => value + 1),
    library,
  }
}

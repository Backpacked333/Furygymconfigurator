import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { serializeDesign, type DesignEnvelope } from '../domain/design'
import {
  decodeNativeImage,
  findNativeImage,
  getNativeLibrary,
  type NativeEntry,
  type NativeLibrary,
} from './nativeLibrary'

export type NativeReply = { mode: 'native-library'; artifact: NativeEntry }
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
    const update = (progress: NativeProgress) => {
      if (active.current !== token || controller.signal.aborted) return
      setSnapshot((previous) => ({
        generation,
        progress,
        shown:
          progress.state === 'ready'
            ? { key, reply: progress.reply, src: progress.src }
            : previous.shown,
      }))
    }
    update({ state: 'pending' })
    void (async () => {
      const library = await getNativeLibrary()
      if (controller.signal.aborted) return
      const entry = findNativeImage(library, design)
      if (!entry) {
        update({
          state: 'unavailable',
          retryable: false,
          message:
            'This exact combination is not in the rendered library yet. Your choices are saved in the design. Choose a rendered build, or undo to return to an available image. No GPU job has been started.',
        })
        return
      }
      const decoded = await decodeNativeImage(entry, controller.signal)
      update({
        state: 'ready',
        reply: { mode: 'native-library', artifact: entry },
        src: decoded.src,
      })
    })().catch((error: unknown) =>
      update({
        state: 'error',
        retryable: true,
        message: error instanceof Error ? error.message : 'The image could not be loaded.',
      }),
    )
    return () => {
      active.current = token + 1
      controller.abort()
    }
  }, [design, key, generation, attempt])
  const progress: NativeProgress =
    snapshot.generation === generation && selection.key === key
      ? snapshot.progress
      : { state: 'pending' }
  return {
    progress,
    shown: snapshot.shown,
    current: snapshot.shown?.key === key && progress.state === 'ready',
    retry: () => retry((value) => value + 1),
  }
}

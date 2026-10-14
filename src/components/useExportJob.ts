import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { Config } from '../lib/config'
import type { CaptureProvider, CaptureRequest, CaptureResult, CaptureSize } from '../lib/capture'
import { assertExportCurrent, exportSnapshot } from '../lib/exportSnapshot'

export type ExportContext = {
  config: Config
  revision: number
  getProvider: () => CaptureProvider | null
  blocked: boolean
}

export function useExportJob(context: ExportContext) {
  const latest = useRef(context)
  const active = useRef<AbortController | null>(null)
  const mounted = useRef(true)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  useLayoutEffect(() => {
    latest.current = context
  })
  useEffect(() => {
    active.current?.abort()
  }, [context.revision, context.blocked])
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
      active.current?.abort()
    }
  }, [])
  const run = async (
    includeScene: boolean,
    action: (job: {
      config: Config
      capture: (mode: CaptureRequest['mode'], size: CaptureSize) => Promise<CaptureResult>
      assertCurrent: () => void
      message: (text: string) => void
    }) => Promise<void>,
  ) => {
    if (active.current) return
    const controller = new AbortController()
    active.current = controller
    setBusy(true)
    setMessage('Preparing export…')
    const current = latest.current
    const snapshot = exportSnapshot(
      current.config,
      current.revision,
      includeScene ? current.getProvider() : null,
    )
    const assertCurrent = () =>
      assertExportCurrent(
        snapshot,
        latest.current.revision,
        latest.current.getProvider(),
        latest.current.blocked,
        controller.signal,
      )
    const message = (text: string) => {
      if (mounted.current) setMessage(text)
    }
    try {
      assertCurrent()
      if (includeScene && !snapshot.provider)
        throw new Error('3D is unavailable. Use an image-free PDF or return to a ready 3D view.')
      await action({
        config: snapshot.config,
        assertCurrent,
        message,
        capture: async (mode, size) => {
          assertCurrent()
          const result = await snapshot.provider!.capture({
            ...size,
            mode,
            framing: mode === 'presentation' ? 'center-crop' : 'current',
            token: snapshot.token!,
            signal: controller.signal,
            onProgress: (phase, fraction) =>
              message(
                `${phase === 'waiting' ? 'Waiting for the current view' : phase === 'rendering' ? 'Rendering native pixels' : 'Encoding PNG'}${phase === 'rendering' ? ` · ${Math.round(fraction * 100)}%` : '…'}`,
              ),
          })
          assertCurrent()
          return result
        },
      })
    } catch (error) {
      message(error instanceof Error ? error.message : 'Export failed. Your design is unchanged.')
    } finally {
      if (active.current === controller) active.current = null
      if (mounted.current) setBusy(false)
    }
  }
  return { busy, message, run, cancel: () => active.current?.abort() }
}

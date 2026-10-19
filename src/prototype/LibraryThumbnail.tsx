import { useEffect, useState } from 'react'
import type { ImageDescriptor } from '../render-library/contracts'
import { decodeLibraryImage } from './renderLibraryClient'
import { canonicalJson } from '../render-library/identity'

/** Dynamic thumbnails are the same verified immutable image, never an unverified URL. */
export function LibraryThumbnail({ image }: { image: ImageDescriptor }) {
  const [shown, setShown] = useState<{ key: string; src: string } | null>(null)
  const descriptor = canonicalJson(image)
  useEffect(() => {
    const image: ImageDescriptor = JSON.parse(descriptor)
    const controller = new AbortController()
    let release: (() => void) | undefined
    void decodeLibraryImage(image, image.design, controller.signal)
      .then((result) => {
        if (controller.signal.aborted) return result.release()
        release = result.release
        setShown({ key: image.imageKey, src: result.src })
      })
      .catch(() => undefined)
    return () => {
      controller.abort()
      release?.()
    }
  }, [descriptor])
  return shown?.key === image.imageKey ? (
    <img src={shown.src} alt="" draggable={false} />
  ) : (
    <span className="prototype-camera-placeholder">
      Ready<small>Select to view</small>
    </span>
  )
}

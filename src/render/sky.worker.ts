import { environmentRadiance, equirectRadiance, studioRadiance, type SkyLook } from '../lib/visuals'

/** Builds the path tracer's sky map off the main thread (pathtrace.ts prepareEnvironment). */
const scope = self as unknown as {
  onmessage: ((event: MessageEvent) => void) | null
  postMessage: (message: unknown, transfer: Transferable[]) => void
}
scope.onmessage = (event) => {
  const { id, look, width, height } = event.data as {
    id: number
    look: SkyLook
    width: number
    height: number
  }
  const data = equirectRadiance(
    width,
    height,
    look.environment === 'studio' ? studioRadiance : (d) => environmentRadiance(d, look),
  )
  scope.postMessage({ id, data }, [data.buffer])
}

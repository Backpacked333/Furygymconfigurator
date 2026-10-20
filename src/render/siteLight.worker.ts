import { siteField } from './siteLight'

/** Works out a design's site light field off the main thread (siteLightNode.ts requestSiteField). */
const scope = self as unknown as {
  onmessage: ((event: MessageEvent) => void) | null
  postMessage: (message: unknown) => void
}
scope.onmessage = (event) => {
  const { id, design } = event.data
  scope.postMessage({ id, field: siteField(design) })
}

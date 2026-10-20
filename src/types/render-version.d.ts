/**
 * The renderer's version, stamped by the build (vite.config.ts, from scripts/render-version.ts):
 * a hash of the sources that change how a still looks. Tests get 'test'.
 */
declare const __RENDER_VERSION__: string

/** The baked stills' manifest as the entry chunk carries it: the hero's part (vite.config.ts). */
declare module 'virtual:fury-stills' {
  const head: import('../lib/stillsManifest').ManifestHead
  export default head
}

/** Every baked still, loaded beside the entry chunk. */
declare module 'virtual:fury-stills/all' {
  const all: Pick<import('../lib/stillsManifest').StillsManifest, 'stills'>
  export default all
}

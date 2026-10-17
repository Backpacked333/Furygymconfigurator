import { readFileSync } from 'node:fs'
import { relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import { isRenderSource, renderVersion } from './scripts/render-version.ts'
import {
  EMPTY_MANIFEST,
  heroPreloadScript,
  manifestHead,
  manifestProblems,
  type StillsManifest,
} from './src/lib/stillsManifest.ts'

const FIBER_THREE = '\0three-for-fiber'

/**
 * React Three Fiber imports the whole 'three' namespace for its JSX catalog, which keeps the classic
 * WebGLRenderer and its GLSL shader library in the bundle (~350 kB) although the app renders only
 * with WebGPURenderer. three/webgpu re-exports the same core classes (both builds share
 * three.core.js), so R3F gets that namespace instead. Its default-renderer path, unused because
 * Scene always passes a `gl` factory, fails loudly rather than with `undefined is not a constructor`.
 */
function fiberUsesWebGPUBuild(): Plugin {
  return {
    name: 'fiber-uses-webgpu-build',
    apply: 'build',
    enforce: 'pre',
    resolveId(source, importer) {
      if (source === 'three' && importer?.includes('/@react-three/fiber/')) return FIBER_THREE
    },
    load(id) {
      if (id !== FIBER_THREE) return
      return [
        "export * from 'three/webgpu'",
        'export class WebGLRenderer {',
        '  constructor() {',
        "    throw new Error('This build renders with WebGPURenderer: pass a gl factory to <Canvas>.')",
        '  }',
        '}',
      ].join('\n')
    },
  }
}

const ROOT = fileURLToPath(new URL('.', import.meta.url))
const STILLS_MANIFEST = fileURLToPath(new URL('./src/stills.manifest.json', import.meta.url))
const HEAD_ID = 'virtual:fury-stills'
const ALL_ID = 'virtual:fury-stills/all'
/** A render source edited in the dev server is looked at once its edits have settled. */
const RECHECK_MS = 300

function readManifest(): StillsManifest {
  try {
    return { ...EMPTY_MANIFEST, ...JSON.parse(readFileSync(STILLS_MANIFEST, 'utf8')) }
  } catch {
    return EMPTY_MANIFEST
  }
}

/**
 * Path-traced stills baked ahead of time (scripts/bake-stills.mjs, src/lib/bakedStills.ts):
 * - Stamps the renderer's version as __RENDER_VERSION__ (src/lib/stillKey.ts): a hash of the
 *   sources that change how a still looks, listed in scripts/render-version.ts, taken when a
 *   build or the dev server starts; the dev server restarts when an edit changes it, so stills
 *   baked by the version before are no longer shown. Stills baked by another version are
 *   ignored. Tests get 'test'.
 * - Splits the manifest: `virtual:fury-stills`, in the entry chunk, carries the default design's
 *   hero stills and the looks' gains alone, so the entry stays the same size however much is
 *   baked; `virtual:fury-stills/all`, loaded beside it, the rest.
 * - Preloads the hero still from index.html's head at the highest priority, ahead of any script,
 *   for a visit that will show it (no share link or draft of another design), so the stage shows
 *   it from its first render.
 * - Warns when the manifest is of another renderer version (every first visit then renders
 *   live), or lists quick bakes.
 */
function bakedStills(): Plugin {
  let version = 'dev'
  const current = () => {
    const manifest = readManifest()
    return manifest.version === version ? manifest : EMPTY_MANIFEST
  }
  return {
    name: 'fury-baked-stills',
    config() {
      version = process.env.VITEST ? 'test' : renderVersion(ROOT)
      return { define: { __RENDER_VERSION__: JSON.stringify(version) } }
    },
    buildStart() {
      if (process.env.VITEST) return
      for (const problem of manifestProblems(readManifest(), version)) this.warn(problem)
    },
    resolveId(id) {
      if (id === HEAD_ID || id === ALL_ID) return `\0${id}`
    },
    load(id) {
      // A bake rewrites the manifest: the dev server loads these again.
      if (id === `\0${HEAD_ID}` || id === `\0${ALL_ID}`) this.addWatchFile(STILLS_MANIFEST)
      if (id === `\0${HEAD_ID}`)
        return `export default ${JSON.stringify(manifestHead(current(), version))}`
      if (id === `\0${ALL_ID}`)
        return `export default ${JSON.stringify({ stills: current().stills })}`
    },
    configureServer(server) {
      // An edit to a render source changes the renderer: the server restarts under the new
      // version, so the stills baked by the old one are no longer taken for this one's.
      let timer: ReturnType<typeof setTimeout> | undefined
      const touched = (file: string) => {
        if (!isRenderSource(relative(ROOT, file).split(sep).join('/'))) return
        clearTimeout(timer)
        timer = setTimeout(() => {
          const next = renderVersion(ROOT)
          if (next === version) return
          server.config.logger.info(
            `Render sources changed (renderer ${version} → ${next}): restarting, so stills baked by ${version} are no longer shown.`,
            { timestamp: true },
          )
          void server.restart()
        }, RECHECK_MS)
      }
      server.watcher.on('change', touched).on('add', touched).on('unlink', touched)
    },
    transformIndexHtml(html) {
      const script = heroPreloadScript(readManifest(), version)
      if (!script) return html
      // Ahead of the scripts and styles, but after the character set (which must come within the
      // page's first 1024 bytes) and the viewport, which the preload's media query depends on.
      const viewport = /<meta name="viewport"[^>]*>/i
      if (!viewport.test(html)) throw new Error('index.html has no viewport <meta>')
      return html.replace(viewport, (meta) => `${meta}\n    <script>\n${script}\n    </script>`)
    },
  }
}

export default defineConfig({
  plugins: [fiberUsesWebGPUBuild(), bakedStills(), react()],
  server: { host: '0.0.0.0', allowedHosts: true },
  build: {
    target: 'es2022',
    rollupOptions: {
      output: {
        // A manual chunk also absorbs the dependencies it shares with the app shell, which then has
        // to wait for that whole chunk. So React and Vite's dynamic-import helper get a small vendor
        // chunk of their own; left alone they landed in 'three' and 'pdf', and the shell could not
        // run until 2.5 MB of 3D and PDF code had loaded. jsPDF needs no manual chunk: as a dynamic
        // import it is split out and loaded on demand anyway.
        manualChunks(id) {
          if (/node_modules\/(react|react-dom|scheduler)\//.test(id)) return 'vendor'
          if (id.includes('vite/preload-helper')) return 'vendor'
          if (id === FIBER_THREE) return 'three'
          if (/node_modules\/(three|@react-three|three-stdlib)\//.test(id)) return 'three'
        },
      },
    },
  },
})

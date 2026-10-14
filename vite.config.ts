import { defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'

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

export default defineConfig({
  plugins: [fiberUsesWebGPUBuild(), react()],
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

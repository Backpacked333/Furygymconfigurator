import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

/** Isolated Node checks only. Never use the app Vite plugins, a browser, or shared dependency caches. */
export default defineConfig({
  root: fileURLToPath(new URL('../../../../../', import.meta.url)),
  publicDir: false,
  esbuild: { jsx: 'automatic' },
  test: {
    environment: 'node',
    include: ['src/render/prototype/capture/browser/*.test.ts'],
    maxWorkers: 1,
    cache: false,
  },
})

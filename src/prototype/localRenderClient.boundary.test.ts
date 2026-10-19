import { describe, expect, it } from 'vitest'
import { build } from 'vite'

// In-memory bundling only. This never starts Vite, a browser, service, capture or render attempt.
describe('local-preview browser bundle isolation', () => {
  it.each(['localRenderClient.ts', 'ImageConfigurator.tsx'])(
    'keeps %s free of Three, Node, private scenes, provider and capture code',
    async (entry) => {
      const result = await build({
        configFile: false,
        envFile: false,
        publicDir: false,
        logLevel: 'silent',
        cacheDir: '/home/ubuntu/Documents/fury-real-handoff/client-bundle-cache',
        esbuild: { jsx: 'automatic' },
        build: {
          write: false,
          minify: false,
          rollupOptions: {
            input: `src/prototype/${entry}`,
            preserveEntrySignatures: 'strict',
          },
        },
      })
      if ('on' in result) throw new Error('Unexpected watcher')
      let sawClient = false
      for (const bundle of Array.isArray(result) ? result : [result])
        for (const output of bundle.output) {
          if (output.type !== 'chunk') continue
          const modules = Object.keys(output.modules)
          sawClient ||= modules.some((name) => name.endsWith('/prototype/localRenderClient.ts'))
          expect(
            modules.filter((name) =>
              /\/render\/|\/three\/|@react-three|node:|\/image-service\/(?:localRender(?:Http|Service|Cache)|http|service|store)\.|\/legacyEntry\.|\/lib\/export\./i.test(
                name,
              ),
            ),
          ).toEqual([])
          expect(output.code).not.toMatch(
            /node:crypto|node:fs|__FURY_LOCAL_CAPTURE__|WebGPURenderer|createCaptureJob|runCapture\(/,
          )
          if (entry === 'localRenderClient.ts') {
            expect(modules.some((name) => name.endsWith('/image-service/protocol.ts'))).toBe(false)
            expect(output.code).not.toContain('diagnostic-svg@1')
          }
        }
      expect(sawClient).toBe(true)
    },
    30000,
  )
})

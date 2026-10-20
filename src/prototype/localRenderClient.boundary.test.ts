import { afterAll, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { build } from 'vite'
import type { OutputChunk } from 'rollup'
import { eagerChunks } from '../../scripts/client-chunks'

const cacheDir = mkdtempSync(join(tmpdir(), 'fury-local-client-cache-'))
afterAll(() => rmSync(cacheDir, { recursive: true, force: true }))

// In-memory bundling only. This never starts Vite, a browser, service, capture or render attempt.
describe('local-preview browser bundle isolation', () => {
  it.each(['localRenderClient.ts', 'ImageConfigurator.tsx'])(
    'keeps %s initially renderer-free and excludes private/provider/capture code from lazy chunks',
    async (entry) => {
      const result = await build({
        configFile: false,
        envFile: false,
        publicDir: false,
        logLevel: 'silent',
        cacheDir,
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
      const chunks: OutputChunk[] = []
      for (const bundle of Array.isArray(result) ? result : [result])
        for (const output of bundle.output) {
          if (output.type !== 'chunk') continue
          chunks.push(output)
          for (const name of Object.keys(output.modules))
            expect(name).not.toMatch(
              /\/render\/(?:cloud|spin|prototype\/)|node:|\/image-service\/(?:localRender(?:Http|Service|Cache)|http|service|store)\./,
            )
          expect(output.code).not.toMatch(
            /node:crypto|node:fs|__FURY_LOCAL_CAPTURE__|createCaptureJob|runCapture\(/,
          )
        }
      for (const output of eagerChunks(chunks)) {
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

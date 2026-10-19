import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'
import { build } from 'vite'
import { describe, expect, it } from 'vitest'
import { isDisplaySelection } from '../src/display/contract'
import { isLocalRenderSelection } from '../src/image-service/localRenderProtocol'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
// In-memory client compilation only. No dev server/browser/private preparation or shared artifacts.
describe('private display public-module boundary', () => {
  it.each(['displayClient.ts', 'useDisplayImage.ts', 'ImageConfigurator.tsx'])(
    'compiles %s without private/server/renderer modules',
    async (entry) => {
      const result = await build({
        root,
        configFile: false,
        envFile: false,
        publicDir: false,
        logLevel: 'silent',
        cacheDir: '/home/ubuntu/Documents/fury-display-handoff/client-bundle-cache',
        define: { 'import.meta.env.DEV': 'true' },
        esbuild: { jsx: 'automatic' },
        build: {
          write: false,
          minify: false,
          reportCompressedSize: false,
          rollupOptions: { input: `src/prototype/${entry}`, preserveEntrySignatures: 'strict' },
        },
      })
      if ('on' in result) throw new Error('Unexpected watcher')
      const modules: string[] = [],
        code: string[] = []
      for (const bundle of Array.isArray(result) ? result : [result])
        for (const output of bundle.output) {
          if (output.type !== 'chunk') continue
          modules.push(...Object.keys(output.modules))
          code.push(output.code)
          expect([...output.imports, ...output.dynamicImports].join('\n')).not.toMatch(
            /node:|three|sqlite|jspdf|__vite-browser-external/,
          )
        }
      expect(modules.some((name) => name.endsWith('/src/prototype/displayClient.ts'))).toBe(true)
      expect(modules.some((name) => name.endsWith('/src/display/contract.ts'))).toBe(true)
      for (const name of modules) {
        expect(name).not.toMatch(
          /\/src\/render\/|\/node_modules\/(three|@react-three|jspdf)\/|node:|__vite-browser-external|\/src\/display\/(session|readiness)\.|\/src\/(App|legacyEntry)\.|\/src\/lib\/export\./,
        )
        if (name.includes('/src/image-service/')) {
          expect(entry).toBe('ImageConfigurator.tsx')
          expect(name).toMatch(/\/(protocol|localRenderProtocol)\.ts$/)
        }
      }
      expect(code.join('\n')).not.toMatch(
        /createPrivateDisplayBackend|__FURY_LOCAL_CAPTURE__|WebGPURenderer|node:sqlite|modal\.run/,
      )
    },
    30_000,
  )
  it('new browser files import only the frozen display contract, never private session/readiness', () => {
    for (const name of ['displayClient.ts', 'useDisplayImage.ts', 'ImageConfigurator.tsx']) {
      const file = resolve(root, 'src/prototype', name)
      const source = ts.createSourceFile(
        file,
        readFileSync(file, 'utf8'),
        ts.ScriptTarget.Latest,
        true,
      )
      let count = 0
      for (const node of source.statements) {
        if (!ts.isImportDeclaration(node) || !ts.isStringLiteral(node.moduleSpecifier)) continue
        if (node.moduleSpecifier.text.includes('/display/')) {
          expect(node.moduleSpecifier.text).toBe('../display/contract')
          count++
        }
      }
      expect(count).toBeGreaterThan(0)
    }
  })
  it.each([
    [true, '?prototype=images&imageMode=private-display', true],
    [false, '?prototype=images&imageMode=private-display', false],
    [true, '', false],
    [true, '?prototype=images', false],
    [true, '?imageMode=private-display', false],
    [true, '?prototype=images&imageMode=local-real', false],
    [true, '?prototype=images&prototype=images&imageMode=private-display', false],
    [true, '?prototype=images&imageMode=private-display&imageMode=private-display', false],
    [true, '?prototype=images&imageMode=private-display&imageMode=local-real', false],
    [true, '?prototype=images&imageMode=private-display%00', false],
  ] as const)('DEV=%s selector %s enables private-display=%s', (dev, query, expected) => {
    expect(isDisplaySelection(dev, query)).toBe(expected)
    if (expected) expect(isLocalRenderSelection(dev, query)).toBe(false)
  })
  it('production bootstrap keeps private endpoints out while including the native library route', async () => {
    const result = await build({
      root,
      configFile: false,
      envFile: false,
      publicDir: false,
      logLevel: 'silent',
      cacheDir: '/home/ubuntu/Documents/fury-display-handoff/client-bundle-cache',
      define: { 'import.meta.env.DEV': 'false' },
      plugins: [
        {
          name: 'test-inert-legacy-entry',
          enforce: 'pre',
          resolveId(id) {
            if (id === './legacyEntry') return '\0display-test-legacy'
          },
          load(id) {
            if (id === '\0display-test-legacy')
              return 'export function mountLegacy() { globalThis.__TEST_LEGACY_SELECTED__ = true }'
          },
        },
      ],
      build: {
        write: false,
        minify: false,
        reportCompressedSize: false,
        rollupOptions: { input: 'src/main.tsx' },
      },
    })
    if ('on' in result) throw new Error('Unexpected watcher')
    const modules: string[] = [],
      code: string[] = []
    for (const bundle of Array.isArray(result) ? result : [result])
      for (const output of bundle.output) {
        if (output.type === 'chunk') {
          modules.push(...Object.keys(output.modules))
          code.push(output.code)
        }
      }
    expect(modules).toContain('\0display-test-legacy')
    expect(modules.some((name) => name.endsWith('/src/prototype/ImageConfigurator.tsx'))).toBe(true)
    expect(modules.some((name) => name.endsWith('/src/prototype/nativeLibrary.ts'))).toBe(true)
    for (const name of modules) {
      expect(name).not.toMatch(/\/src\/render\//)
      expect(name).not.toMatch(/\/src\/display\/(?:session|readiness|operator)\./)
      if (name.includes('/src/image-service/'))
        expect(name).toMatch(/\/(?:protocol|localRenderProtocol)\.ts$/)
    }
    expect(code.join('\n')).not.toMatch(
      /createPrivateDisplayBackend|modal\.run|private-display-service|\/__fury-(?:local|display)\/v1\//,
    )
    // This does not build or test the renderer-backed legacy application while other lanes edit it.
    expect(readFileSync(resolve(root, 'src/legacyEntry.tsx'), 'utf8')).toContain(
      "import App from './App'",
    )
  }, 30_000)
})

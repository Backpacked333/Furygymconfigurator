// @vitest-environment node
import { fileURLToPath } from 'node:url'
import { build, type Plugin } from 'vite'
import { afterEach, describe, expect, it, vi } from 'vitest'
import configuration from '../vite.config'
import type { OutputChunk } from 'rollup'
import { eagerChunks } from './client-chunks'

const root = fileURLToPath(new URL('..', import.meta.url))
const pluginName = 'fury-local-mock-image-prototype'
const sharedPresentation = [
  'ConfiguratorShell',
  'ConfigPanelView',
  'StageHeader',
  'StagePresentation',
  'StagePresentationHooks',
  'StageToolbarView',
  'BuildDialogView',
  'SpecificationView',
  'FloorPlan',
] as const
afterEach(() => vi.unstubAllEnvs())

async function configuredPlugins(command: 'serve' | 'build', mode: string, isPreview = false) {
  if (typeof configuration !== 'function')
    throw new Error('Expected conditional Vite configuration')
  const config = await configuration({ command, mode, isPreview })
  return (config.plugins ?? []).flat().filter(Boolean) as Plugin[]
}

function receipt() {
  const modules = new Set<string>()
  const imports = new Set<string>()
  const chunks: string[] = []
  const outputs: OutputChunk[] = []
  const plugin: Plugin = {
    name: 'prototype-test-module-receipt',
    generateBundle(_options, bundle) {
      for (const output of Object.values(bundle)) {
        if (output.type !== 'chunk') continue
        outputs.push(output)
        for (const id of Object.keys(output.modules)) modules.add(id.replaceAll('\\', '/'))
        for (const id of [...output.imports, ...output.dynamicImports]) imports.add(id)
        chunks.push(output.code)
      }
    },
  }
  return { modules, imports, chunks, outputs, plugin }
}

describe('built next-batch boundaries (no browser or dev server)', () => {
  it('adds the local service plugin only to explicitly opted-in nonproduction serve configuration', async () => {
    vi.stubEnv('NODE_ENV', 'development')
    vi.stubEnv('FURY_IMAGE_PROTOTYPE', '')
    expect((await configuredPlugins('serve', 'development')).map((p) => p.name)).not.toContain(
      pluginName,
    )
    vi.stubEnv('FURY_IMAGE_PROTOTYPE', 'true')
    expect((await configuredPlugins('serve', 'development')).map((p) => p.name)).not.toContain(
      pluginName,
    )
    vi.stubEnv('FURY_IMAGE_PROTOTYPE', '1')
    expect((await configuredPlugins('serve', 'development')).map((p) => p.name)).toContain(
      pluginName,
    )
    expect(
      (await configuredPlugins('serve', 'development', true)).map((p) => p.name),
    ).not.toContain(pluginName)
    expect((await configuredPlugins('build', 'development')).map((p) => p.name)).not.toContain(
      pluginName,
    )
    expect((await configuredPlugins('serve', 'production')).map((p) => p.name)).not.toContain(
      pluginName,
    )
    vi.stubEnv('NODE_ENV', 'production')
    expect((await configuredPlugins('serve', 'development')).map((p) => p.name)).not.toContain(
      pluginName,
    )
  })

  it('keeps initial gallery JS renderer-free and the lazy live graph free of cloud/server dependencies', async () => {
    const graph = receipt()
    await build({
      root,
      configFile: false,
      logLevel: 'silent',
      plugins: [graph.plugin],
      build: {
        write: false,
        copyPublicDir: false,
        minify: false,
        reportCompressedSize: false,
        lib: {
          entry: fileURLToPath(new URL('../src/prototype/ImageConfigurator.tsx', import.meta.url)),
          formats: ['es'],
          fileName: 'prototype-boundary',
        },
      },
    })
    const initial = eagerChunks(graph.outputs)
    const modules = initial.flatMap((chunk) => Object.keys(chunk.modules))
    expect([...graph.modules].some((id) => id.endsWith('/src/prototype/LiveDesignScene.tsx'))).toBe(
      true,
    )
    expect(modules.some((id) => id.endsWith('/src/prototype/LiveDesignScene.tsx'))).toBe(false)
    expect(modules.some((id) => id.endsWith('/src/prototype/ImageConfigurator.tsx'))).toBe(true)
    expect(modules.some((id) => id.endsWith('/src/image-service/protocol.ts'))).toBe(true)
    expect(modules.some((id) => id.endsWith('/src/image-service/localRenderProtocol.ts'))).toBe(
      true,
    )
    expect(modules.some((id) => id.endsWith('/src/domain/design.ts'))).toBe(true)
    expect(modules.length).toBeGreaterThan(20)
    for (const component of sharedPresentation)
      expect(
        modules.some((id) => id.endsWith(`/src/components/${component}.tsx`)),
        component,
      ).toBe(true)
    for (const id of modules) {
      expect(id).not.toMatch(
        /node_modules\/(three|@react-three|three-stdlib|jspdf|sharp)|\/src\/render\/|\/src\/render-library\/server\/|\/render-server\/|\/src\/review\/|\/src\/(App|legacyEntry)\.tsx|node:|__vite-browser-external|\/src\/lib\/(export|useConfig)\.ts|\/src\/components\/(ConfigPanel|StageToolbar|Dialogs)\.tsx/,
      )
      if (id.includes('/src/image-service/'))
        expect(id).toMatch(/\/(?:protocol|localRenderProtocol)\.ts$/)
    }
    for (const id of initial.flatMap((chunk) => chunk.imports))
      expect(id).not.toMatch(/node:|sqlite|three|jspdf|__vite-browser-external/)
    for (const id of graph.modules)
      expect(id).not.toMatch(
        /\/src\/render\/(?:cloud|spin|prototype\/)|\/src\/render-library\/server\/|\/render-server\/|node:|__vite-browser-external/,
      )
    expect(graph.chunks.join('\n')).not.toMatch(
      /node:sqlite|DatabaseSync|\/(?:warm|render)(?=[/"'?\s]|$)|modal\.run/,
    )
  }, 60_000)

  it('builds the local mock runtime without provider, network, process or scene-preparation dependencies', async () => {
    const graph = receipt()
    await build({
      root,
      configFile: false,
      logLevel: 'silent',
      plugins: [graph.plugin],
      build: {
        ssr: fileURLToPath(new URL('../src/image-service/service.ts', import.meta.url)),
        write: false,
        copyPublicDir: false,
        minify: false,
      },
    })
    expect([...graph.modules].some((id) => id.endsWith('/src/image-service/fakeRenderer.ts'))).toBe(
      true,
    )
    for (const id of [...graph.modules, ...graph.imports]) {
      expect(id).not.toMatch(
        /node:(http|https|net|tls|child_process|worker_threads)|\/src\/render\/|three|jspdf|supabase|modal|ai-gateway/,
      )
    }
    expect(graph.chunks.join('\n')).not.toMatch(
      /\bfetch\s*\(|node:(http|https|net|tls|child_process|worker_threads)|modal\.run/,
    )
  }, 60_000)

  it('ordinary production output excludes new prototype/mock/service features even with the local service flag set', async () => {
    vi.stubEnv('FURY_IMAGE_PROTOTYPE', '1')
    vi.stubEnv('NODE_ENV', 'production')
    vi.stubEnv('FURY_LOCAL_REAL_IMAGES', '1')
    const graph = receipt()
    await build({
      root,
      configFile: fileURLToPath(new URL('../vite.config.ts', import.meta.url)),
      configLoader: 'runner',
      logLevel: 'silent',
      plugins: [graph.plugin],
      build: { write: false, copyPublicDir: false, minify: false, reportCompressedSize: false },
    })
    const modules = [...graph.modules]
    expect(modules.some((id) => id.endsWith('/src/App.tsx'))).toBe(true)
    expect(modules.some((id) => id.endsWith('/src/legacyEntry.tsx'))).toBe(true)
    expect(modules.some((id) => id.endsWith('/src/prototype/ImageConfigurator.tsx'))).toBe(true)
    expect(modules.some((id) => id.endsWith('/src/prototype/nativeLibrary.ts'))).toBe(true)
    for (const component of sharedPresentation)
      expect(
        modules.some((id) => id.endsWith(`/src/components/${component}.tsx`)),
        component,
      ).toBe(true)
    for (const id of modules) {
      expect(id).not.toMatch(
        /\/src\/render\/prototype\/|\/src\/review\/|\/scripts\/prototype-|\/src\/display\/(?:session|readiness|operator)\.|node:sqlite/,
      )
      if (id.includes('/src/image-service/'))
        expect(id).toMatch(/\/(?:protocol|localRenderProtocol)\.ts$/)
    }
    expect(graph.chunks.join('\n')).not.toMatch(
      /node:sqlite|DatabaseSync|modal\.run|createPrivateDisplayBackend|private-display-service/,
    )
  }, 120_000)
})

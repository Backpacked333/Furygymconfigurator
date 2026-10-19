import { readFileSync, realpathSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  isFileLoadingAllowed,
  isFileServingAllowed,
  resolveConfig,
  searchForWorkspaceRoot,
  type UserConfigFnPromise,
} from 'vite'
import configuration from '../vite.config'

// Only config registration is tested: no private backend factories or middleware execute.
vi.mock('./cloud-display-service-plugin.ts', () => ({
  cloudDisplayServicePlugin: () => ({ name: 'inert-cloud-service' }),
}))
vi.mock('./display-service-plugin.ts', () => ({
  displayServicePlugin: () => ({ name: 'inert-local-service' }),
}))
vi.mock('./local-render-plugin.ts', () => ({
  localRenderPlugin: () => ({ name: 'inert-local-render' }),
}))

const root = fileURLToPath(new URL('../', import.meta.url))
const config = configuration as UserConfigFnPromise

describe('narrow symlinked font allowlist (in-process config only, no server/browser)', () => {
  afterEach(() => vi.unstubAllEnvs())
  it('registers cloud before the broad local handler only in DEV serve config', async () => {
    vi.stubEnv('NODE_ENV', 'test')
    vi.stubEnv('FURY_IMAGE_PROTOTYPE', '0')
    const raw = await config({ command: 'serve', mode: 'development', isPreview: false })
    const names =
      raw.plugins
        ?.flat()
        .flatMap((p) => (p && typeof p === 'object' && 'name' in p ? [p.name] : [])) ?? []
    expect(names.indexOf('inert-cloud-service')).toBeGreaterThan(-1)
    expect(names.indexOf('inert-cloud-service')).toBeLessThan(names.indexOf('inert-local-service'))
    vi.stubEnv('NODE_ENV', 'production')
    const production = await config({ command: 'serve', mode: 'development', isPreview: false })
    expect(
      production.plugins
        ?.flat()
        .some((p) => p && typeof p === 'object' && 'name' in p && p.name === 'inert-cloud-service'),
    ).toBe(false)
  })
  it('permits actual imported font asset realpaths while keeping unrelated dependency/private paths outside the allowlist', async () => {
    // Build evaluation avoids importing any private service. The same server.fs object is used in DEV.
    const raw = await config({ command: 'build', mode: 'test', isPreview: false })
    const fonts = ['manrope', 'dm-sans'].map((font) =>
      realpathSync(join(root, `node_modules/@fontsource/${font}/files`)),
    )
    expect(raw.server?.fs).toEqual({
      strict: true,
      allow: [searchForWorkspaceRoot(root), ...fonts],
    })
    const resolved = await resolveConfig(
      { ...raw, plugins: [], configFile: false, envFile: false, root },
      'serve',
      'test',
    )
    const main = readFileSync(join(root, 'src/main.tsx'), 'utf8')
    const imports = [...main.matchAll(/import '(@fontsource\/[^']+\.css)'/g)].map((m) => m[1])
    expect(imports).toHaveLength(8)
    let checked = 0
    for (const path of imports) {
      const css = realpathSync(join(root, 'node_modules', path))
      const urls = [
        ...readFileSync(css, 'utf8').matchAll(/url\((?:['"])?(\.\/files\/[^)'"\s]+)(?:['"])?\)/g),
      ].map((m) => m[1])
      expect(urls.length).toBeGreaterThan(0)
      for (const url of urls) {
        const file = realpathSync(join(dirname(css), url))
        expect(isFileLoadingAllowed(resolved, file)).toBe(true)
        expect(isFileServingAllowed(resolved, `/@fs${file}`)).toBe(true)
        checked++
      }
    }
    expect(checked).toBeGreaterThanOrEqual(14)
    const dependencies = realpathSync(join(root, 'node_modules'))
    for (const file of [
      join(dependencies, 'three/package.json'),
      join(dependencies, '@fontsource/manrope/package.json'),
      join(dependencies, '@fontsource/dm-sans/latin-400.css'),
      join(dirname(root.replace(/\/$/, '')), 'fury-display/src/display/operator.ts'),
      '/home/ubuntu/unrelated-private-file',
    ])
      expect(isFileLoadingAllowed(resolved, file)).toBe(false)
  })
  it('keeps private services out of build, production and preview config evaluation', async () => {
    for (const env of [
      { command: 'build' as const, mode: 'production', isPreview: false },
      { command: 'serve' as const, mode: 'production', isPreview: false },
      { command: 'serve' as const, mode: 'development', isPreview: true },
    ]) {
      const raw = await config(env)
      const plugins = raw.plugins?.flat().filter(Boolean)
      expect(
        plugins?.some(
          (p) =>
            typeof p === 'object' &&
            p &&
            'name' in p &&
            /service|local-render/.test(String(p.name)),
        ),
      ).toBe(false)
    }
  })
})

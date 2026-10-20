import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'
import { describe, expect, it, vi } from 'vitest'

const ROOT = fileURLToPath(new URL('../', import.meta.url))

describe('retired legacy paid-render entry points', () => {
  it.each([
    { args: [] },
    { args: ['--quick'] },
    {
      args: ['--server', 'https://gpu.example', '--allow-dirty', '--no-build', '--fresh', '--blob'],
    },
  ])('bake refuses before networking, building or changing manifests: $args', ({ args }) => {
    const manifest = readFileSync(new URL('../src/stills.manifest.json', import.meta.url))
    const result = spawnSync(process.execPath, ['scripts/bake-stills.mjs', ...args], {
      cwd: ROOT,
      env: { PATH: '/usr/bin:/bin', FURY_BAKE_TOKEN: 'test-token' },
      encoding: 'utf8',
      timeout: 5_000,
    })
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('LEGACY_RENDER_DISABLED')
    expect(readFileSync(new URL('../src/stills.manifest.json', import.meta.url))).toEqual(manifest)
  })

  it('bake help explains the retirement rather than offering a bypass', () => {
    const result = spawnSync(process.execPath, ['scripts/bake-stills.mjs', '--help'], {
      cwd: ROOT,
      env: { PATH: '/usr/bin:/bin' },
      encoding: 'utf8',
      timeout: 5_000,
    })
    expect(result.status).toBe(0)
    expect(result.stdout).toContain('LEGACY_RENDER_DISABLED')
  })

  it('compiled production settings cannot select or warm even a configured remote renderer', async () => {
    const result = await build({
      absWorkingDir: ROOT,
      stdin: {
        contents:
          "export {cloudUrl} from './src/render/traceStatus'; export {warmCloud} from './src/render/renderSession'",
        resolveDir: ROOT,
      },
      bundle: true,
      write: false,
      format: 'cjs',
      platform: 'browser',
      minify: true,
      define: {
        'import.meta.env.DEV': 'false',
        'import.meta.env.VITE_CLOUD_RENDER_URL': JSON.stringify('https://gpu.example'),
      },
    })
    const fetch = vi.fn()
    const module = {
      exports: {} as { cloudUrl(search: string): string | null; warmCloud(url: string): void },
    }
    new Function('module', 'exports', 'fetch', result.outputFiles[0].text)(
      module,
      module.exports,
      fetch,
    )
    for (const url of ['https://gpu.example', 'http://127.0.0.1:8787']) {
      expect(module.exports.cloudUrl(`?cloud=${encodeURIComponent(url)}`)).toBeNull()
      module.exports.warmCloud(url)
    }
    expect(fetch).not.toHaveBeenCalled()
  })
})

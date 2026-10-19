// Native import/in-memory build proof only. No runCapture, browser, port, ledger or render attempt.
import { execFile } from 'node:child_process'
import { lstat, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import { build } from 'esbuild'
import { expect, it } from 'vitest'
import { LOCAL_RENDER_HISTORY_DIRECTORY, LOCAL_RENDER_SOURCE_ROOT } from './localRenderPrivate'

it('keeps host/runner native, resolves extensionless TS, preserves fixed root/history and deterministic current build', async () => {
  const root = await mkdtemp(join(tmpdir(), 'fury-service-import-check-'))
  const before = await lstat(LOCAL_RENDER_HISTORY_DIRECTORY).catch(
    (error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return null
      throw error
    },
  )
  try {
    const compiled = await build({
      entryPoints: [join(LOCAL_RENDER_SOURCE_ROOT, 'src/image-service/localRenderPrivate.ts')],
      bundle: true,
      packages: 'external',
      platform: 'node',
      format: 'esm',
      target: 'node24',
      write: false,
      metafile: true,
    })
    expect(
      Object.keys(compiled.metafile!.inputs).every((name) =>
        /localRender(?:Private|Preparation)\.ts$/.test(name),
      ),
    ).toBe(true)
    await writeFile(join(root, 'adapter.mjs'), compiled.outputFiles[0].contents)
    await writeFile(
      join(root, 'probe.mjs'),
      `
import { createLocalRenderBackend, LOCAL_RENDER_SOURCE_ROOT, LOCAL_RENDER_HISTORY_DIRECTORY } from ${JSON.stringify(pathToFileURL(join(LOCAL_RENDER_SOURCE_ROOT, 'src/image-service/localRenderPrivate.ts')).href)};
const backend = createLocalRenderBackend(LOCAL_RENDER_SOURCE_ROOT);
const originalEnv = process.env.NODE_ENV;
const first = await backend.prepare(() => {});
let second;
try {
  await first.revalidate();
  second = await backend.prepare(() => {});
  await second.revalidate();
} catch (error) {
  const { readFile } = await import('node:fs/promises');
  const { createHash } = await import('node:crypto');
  const changed = [];
  for (const record of [...first.manifests.sources, ...first.manifests.assets]) {
    const bytes = await readFile(LOCAL_RENDER_SOURCE_ROOT + '/' + record.name);
    if ('sha256:' + createHash('sha256').update(bytes).digest('hex') !== record.digest) changed.push(record.name);
  }
  console.error('Current source/asset changes during read-only check:', JSON.stringify(changed));
  throw error;
}
if (JSON.stringify(first.build) !== JSON.stringify(second.build)) throw new Error('Nondeterministic current build');
if (process.env.NODE_ENV !== originalEnv) throw new Error('Parent environment changed');
try {
  await first.revalidate();
  throw new Error('Old prepared generation was incorrectly accepted');
} catch (error) {
  if (error.code !== 'identity-mismatch') throw error;
}
const host = await import('file://' + LOCAL_RENDER_SOURCE_ROOT + '/src/render/prototype/capture/host.ts');
const runner = await import('file://' + LOCAL_RENDER_SOURCE_ROOT + '/src/render/prototype/capture/runner.ts');
if (host.SOURCE_ROOT !== LOCAL_RENDER_SOURCE_ROOT || runner.HISTORY_DIRECTORY !== LOCAL_RENDER_HISTORY_DIRECTORY) throw new Error('Private root/history drift');
backend.close();
console.log(JSON.stringify({ sourceRoot: host.SOURCE_ROOT, historyDirectory: runner.HISTORY_DIRECTORY, deterministicBuild: true, build: first.build, sourceRecords: first.manifests.sources.length, assetRecords: first.manifests.assets.length, captureCalled: false, rendererStarted: false }));
`,
    )
    const reports = []
    for (const NODE_ENV of ['development', 'production']) {
      const { stdout } = await promisify(execFile)(process.execPath, [join(root, 'probe.mjs')], {
        cwd: LOCAL_RENDER_SOURCE_ROOT,
        timeout: 150_000,
        maxBuffer: 128 * 1024,
        env: { PATH: process.env.PATH, HOME: process.env.HOME, NODE_NO_WARNINGS: '1', NODE_ENV },
      })
      const report = JSON.parse(stdout.trim()) as Record<string, unknown>
      reports.push(report)
      expect(report).toMatchObject({
        sourceRoot: LOCAL_RENDER_SOURCE_ROOT,
        historyDirectory: LOCAL_RENDER_HISTORY_DIRECTORY,
        deterministicBuild: true,
        captureCalled: false,
        rendererStarted: false,
        assetRecords: 78,
      })
      await writeFile(
        join(root, 'service-private-import-check.json'),
        JSON.stringify(report, null, 2),
      )
      const after = await lstat(LOCAL_RENDER_HISTORY_DIRECTORY).catch(
        (error: NodeJS.ErrnoException) => {
          if (error.code === 'ENOENT') return null
          throw error
        },
      )
      expect(after).toEqual(before)
    }
    expect(reports[0]).toEqual(reports[1])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}, 180_000)

it('does not bundle native host/runner/browser code into the Vite adapter graph', async () => {
  const compiled = await build({
    entryPoints: [join(LOCAL_RENDER_SOURCE_ROOT, 'scripts/local-render-plugin.ts')],
    bundle: true,
    packages: 'external',
    platform: 'node',
    format: 'esm',
    target: 'node24',
    write: false,
    metafile: true,
  })
  const names = Object.keys(compiled.metafile!.inputs)
  expect(
    names.some((name) =>
      /capture\/(?:host|runner|runner-browser)\.ts$|capture\/browser\//.test(name),
    ),
  ).toBe(false)
  expect(names.some((name) => name.endsWith('localRenderService.ts'))).toBe(true)
  expect(names.some((name) => /image-service\/(?:store|service)\.ts$/.test(name))).toBe(false)
})

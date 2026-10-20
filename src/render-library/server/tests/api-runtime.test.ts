import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'
import { expect, it } from 'vitest'

const root = fileURLToPath(new URL('../../../../', import.meta.url))
const entries = [
  'lookup.ts',
  'variants.ts',
  'session.ts',
  'jobs/index.ts',
  'jobs/[jobId]/index.ts',
  'jobs/[jobId]/retry.ts',
  'worker/claim.ts',
  'worker/uploads.ts',
  'worker/events.ts',
].map((name) => `api/render-library/${name}`)

it('loads emitted API handlers in native Node ESM without a bundler resolver', () => {
  const output = mkdtempSync(join(root, '.render-library-runtime-'))
  try {
    const pending = entries.map((entry) => join(root, entry))
    const emitted = new Set<string>()
    while (pending.length) {
      const sourcePath = pending.pop()!
      if (emitted.has(sourcePath)) continue
      emitted.add(sourcePath)
      const source = readFileSync(sourcePath, 'utf8')
      for (const dependency of ts.preProcessFile(source).importedFiles) {
        if (!dependency.fileName.startsWith('.')) continue
        const target = resolve(dirname(sourcePath), dependency.fileName)
        pending.push(target.endsWith('.js') ? target.slice(0, -3) + '.ts' : target + '.ts')
      }
      const target = join(output, relative(root, sourcePath).replace(/\.ts$/, '.js'))
      mkdirSync(dirname(target), { recursive: true })
      writeFileSync(
        target,
        ts.transpileModule(source, {
          compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
          fileName: sourcePath,
        }).outputText,
      )
    }
    const script = `
      import assert from 'node:assert/strict';
      import { pathToFileURL } from 'node:url';
      const entries = ${JSON.stringify(entries.map((entry) => join(output, entry.replace(/\.ts$/, '.js'))))};
      for (const entry of entries) {
        const handler = await import(pathToFileURL(entry).href);
        const method = handler.GET ? 'GET' : 'POST';
        const response = await handler[method](new Request('https://example.test/api/render-library/lookup', {
          method,
          ...(method === 'POST' ? { headers: { 'Content-Type': 'application/json' }, body: '{}' } : {}),
        }));
        const expected = entry.includes('/worker/') ? 403 : entry.endsWith('/lookup.js') || entry.endsWith('/variants.js') ? 400 : 503;
        assert.equal(response.status, expected, entry);
        assert.equal(response.headers.get('cache-control'), 'no-store');
        assert.ok((await response.json()).error);
      }
      console.log('All nine native ESM handlers loaded and failed closed.');
    `
    expect(
      execFileSync(process.execPath, ['--input-type=module', '--eval', script], {
        cwd: root,
        env: { PATH: process.env.PATH, NODE_NO_WARNINGS: '1' },
        encoding: 'utf8',
        timeout: 30_000,
      }),
    ).toContain('All nine native ESM handlers loaded and failed closed.')
  } finally {
    rmSync(output, { recursive: true, force: true })
  }
}, 45_000)

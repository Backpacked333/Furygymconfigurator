// @vitest-environment node
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtemp, readFile, readdir, rm, writeFile, mkdir, symlink } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

const exec = promisify(execFile)
const root = fileURLToPath(new URL('../', import.meta.url))
const loader = './src/render/prototype/register.ts'
let sandbox: string
const digest = (value: string | Buffer) =>
  `sha256:${createHash('sha256').update(value).digest('hex')}`
const cli = (args: string[]) =>
  exec(process.execPath, ['--import', loader, './scripts/prototype-fixtures.ts', ...args], {
    cwd: root,
    env: { ...process.env, NODE_ENV: 'production' },
    timeout: 60000,
    maxBuffer: 1024 * 1024,
  })

beforeEach(async () => {
  sandbox = await mkdtemp(join(root, 'src/render/prototype/.test-output-'))
})
afterEach(async () => {
  await rm(sandbox, { recursive: true, force: true })
})

describe('local-only prototype fixture command', () => {
  it('writes six designs, six real geometry manifests, 28-case G1 plan and verified completion last', async () => {
    const output = join(sandbox, 'new-review')
    const run = await cli(['--out', output])
    const receipt = JSON.parse(run.stdout)
    expect(receipt.counts.compositionCases).toBe(28)
    expect(await readdir(output)).toHaveLength(45)
    const complete = JSON.parse(await readFile(join(output, 'COMPLETE.json'), 'utf8'))
    expect(complete.approval).toBe(false)
    expect(complete.files).toHaveLength(44)
    for (const file of complete.files) {
      const bytes = await readFile(join(output, file.name))
      expect(bytes.byteLength).toBe(file.bytes)
      expect(digest(bytes)).toBe(file.digest)
    }
    const scene = JSON.parse(await readFile(join(output, 'studio-40-baseline.scene.json'), 'utf8'))
    expect(scene.equipment).toHaveLength(6)
    expect(scene.instances.length).toBeGreaterThan(500)
    expect(scene.renderer.artifactDigest).toBeNull()
    const verified = JSON.parse((await cli(['--verify', output])).stdout)
    expect(verified.valid).toBe(true)
    expect(verified.files).toBe(45)
    const referencePath = join(output, 'strict-reference-manifest.json')
    const referenceBytes = await readFile(referencePath, 'utf8')
    await writeFile(
      referencePath,
      referenceBytes.replace('"requestedSamplesPerPixel":1024', '"requestedSamplesPerPixel":1023'),
    )
    await expect(cli(['--verify', output])).rejects.toThrow(/Review identity mismatch/)
    await writeFile(referencePath, referenceBytes)
    await writeFile(join(output, 'unknown.json'), '{}')
    await expect(cli(['--verify', output])).rejects.toThrow(/unknown review files/)
  }, 120000)

  it('is byte-for-byte reproducible across fresh Node processes and new output paths', async () => {
    const a = join(sandbox, 'first'),
      b = join(sandbox, 'second')
    await cli(['--out', a])
    await cli(['--out', b])
    for (const file of await readdir(a))
      expect(await readFile(join(a, file))).toEqual(await readFile(join(b, file)))
  }, 120000)

  it('never overwrites any existing directory or raw legacy/review value', async () => {
    const output = join(sandbox, 'existing')
    await mkdir(output)
    const raw = 'malformed/future/raw original {not json'
    await writeFile(join(output, 'original.json'), raw)
    await expect(cli(['--out', output])).rejects.toThrow(/EEXIST/)
    expect(await readdir(output)).toEqual(['original.json'])
    expect(await readFile(join(output, 'original.json'), 'utf8')).toBe(raw)
  }, 60000)

  it('admits only one concurrent writer and does not merge the losing output', async () => {
    const output = join(sandbox, 'race')
    const attempts = await Promise.allSettled([cli(['--out', output]), cli(['--out', output])])
    expect(attempts.filter((result) => result.status === 'fulfilled')).toHaveLength(1)
    expect(attempts.filter((result) => result.status === 'rejected')).toHaveLength(1)
    expect(await readdir(output)).toHaveLength(45)
  }, 60000)

  it('leaves failed output incomplete and refuses later implicit recovery/replacement', async () => {
    const output = join(sandbox, 'failed')
    await exec(
      process.execPath,
      [
        '--import',
        loader,
        '--input-type=module',
        '-e',
        `
      import fs from 'node:fs/promises';
      import { syncBuiltinESMExports } from 'node:module';
      import assert from 'node:assert/strict';
      const original = fs.open;
      fs.open = async function(path, ...args) {
        if (String(path).endsWith('.scene.json')) throw new Error('injected disk failure');
        return original(path, ...args);
      };
      syncBuiltinESMExports();
      const { writePrototypeReviewManifests } = await import('./src/render/prototype/writeManifests.ts');
      await assert.rejects(writePrototypeReviewManifests(${JSON.stringify(output)}), /injected disk failure/);
    `,
      ],
      { cwd: root, timeout: 60000, env: { ...process.env, NODE_ENV: 'production' } },
    )
    expect(await readdir(output)).toEqual(['studio-20-baseline.fixture.json'])
    const original = await readFile(join(output, 'studio-20-baseline.fixture.json'))
    await expect(cli(['--out', output])).rejects.toThrow(/EEXIST/)
    expect(await readFile(join(output, 'studio-20-baseline.fixture.json'))).toEqual(original)
  }, 60000)

  it('rejects symlink parents and malformed CLI flags without writing manifests', async () => {
    const link = join(sandbox, 'linked')
    await symlink(sandbox, link, 'dir')
    await expect(cli(['--out', join(link, 'new-output')])).rejects.toThrow(/Symlink/)
    for (const args of [
      [],
      ['--out'],
      ['--out', '--render'],
      ['--out', join(sandbox, 'out'), '--force'],
      ['--render', 'paid'],
    ])
      await expect(cli(args)).rejects.toThrow(/Usage:/)
    expect(await readdir(sandbox)).toEqual(['linked'])
  }, 60000)
})

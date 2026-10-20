// @vitest-environment node
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const root = fileURLToPath(new URL('../../../../', import.meta.url))
async function check(code: string) {
  const result = await promisify(execFile)(
    process.execPath,
    [
      '--import',
      './src/render/prototype/register.ts',
      '--input-type=module',
      '-e',
      `
      import assert from 'node:assert/strict';
      import { defaultDesign, parseDesign } from './src/domain/design.ts';
      import { compileCyclesConstruction, worldGeometry } from './src/render/prototype/cycles/compile.ts';
      import { createPrototypeFixtures } from './src/render/prototype/fixtures.ts';
      import { Matrix4, BoxGeometry } from 'three';
      globalThis.fetch = () => { throw new Error('No network'); };
      ${code}
      console.log('ok');
    `,
    ],
    { cwd: root, timeout: 60000, maxBuffer: 1024 * 1024 },
  )
  expect(result.stdout.trim()).toBe('ok')
}

describe('private Cycles construction compiler', { timeout: 65_000 }, () => {
  it('replays byte-exactly without browser pixels or rendering', async () =>
    check(`
    const a = compileCyclesConstruction(defaultDesign());
    const b = compileCyclesConstruction(defaultDesign());
    assert.equal(a.digest, b.digest); assert.deepEqual(a.bytes, b.bytes);
    assert.equal(a.manifest.scene.objects.length, 353);
    for (const [hash, blob] of a.blobs) assert.deepEqual(blob.bytes, b.blobs.get(hash).bytes);
    assert.equal(a.manifest.settings.adaptiveSampling, false);
    assert.equal(a.manifest.execution.referenceDispatchAllowed, false);
    assert.equal(a.manifest.scene.environment, null);
    assert.equal(a.manifest.scene.lights.length, 0);
  `))
  it('binds all six configured fixtures, and changes identity for night and portrait', async () =>
    check(`
    const hashes = createPrototypeFixtures().map(f => compileCyclesConstruction(f.design).digest);
    assert.equal(new Set(hashes).size, 6);
    const base = defaultDesign();
    const wide = compileCyclesConstruction(base);
    const tall = compileCyclesConstruction(parseDesign({...base, presentation:{...base.presentation, aspect:'tall'}}));
    const night = compileCyclesConstruction(parseDesign({...base, presentation:{...base.presentation, lookRef:'courtyard-night-draft@1'}}));
    assert.equal(tall.manifest.height, 1500); assert.equal(tall.manifest.width, 1200);
    assert.notEqual(wide.digest, tall.digest); assert.notEqual(wide.digest, night.digest);
  `))
  it('rejects arbitrary renderer, camera, mesh and asset inputs', async () =>
    check(`
    for (const key of ['samples','camera','meshes','assetUrl','time_limit'])
      assert.throws(() => compileCyclesConstruction({...defaultDesign(), [key]:key}));
  `))
  it('bakes transforms with inverse-transpose normals and reverses mirrored winding', async () =>
    check(`
    const geometry = new BoxGeometry();
    const before = Array.from(geometry.attributes.position.array);
    const matrix = new Matrix4().makeScale(-2,3,4).setPosition(5,6,7);
    const bytes = worldGeometry(geometry, matrix);
    const length = bytes.readUInt32LE(4);
    const h = JSON.parse(bytes.subarray(8,8+length));
    const start = 8+length;
    const original = geometry.attributes.position;
    assert.equal(bytes.readFloatLE(start + h.position), 5-2*original.getX(0));
    assert.equal(bytes.readFloatLE(start + h.position+4), 6+3*original.getY(0));
    assert.equal(bytes.readUInt32LE(start+h.index.offset+4), geometry.index.array[2]);
    assert.equal(bytes.readUInt32LE(start+h.index.offset+8), geometry.index.array[1]);
    assert.deepEqual(Array.from(original.array), before);
    geometry.dispose();
  `))
})

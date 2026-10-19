// @vitest-environment node
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const exec = promisify(execFile)
const root = fileURLToPath(new URL('../../../', import.meta.url))
async function check(source: string) {
  const result = await exec(
    process.execPath,
    [
      '--import',
      './src/render/prototype/register.ts',
      '--input-type=module',
      '-e',
      `
    import assert from 'node:assert/strict';
    import { defaultDesign, parseDesign, serializeDesign, deserializeDesign, projectDesignToConfig } from './src/domain/design.ts';
    import { arrangementFor } from './src/domain/arrangements.ts';
    import { preparePrototypeScene, PREPARATION_CAPABILITIES } from './src/render/prototype/prepare.ts';
    import { createPrototypeFixtures, createG1ReviewBundle, prototypeFixtureSchema } from './src/render/prototype/fixtures.ts';
    import { canonical, digest } from './src/render/prototype/identity.ts';
    import { UNIT_LISTS } from './src/render/unitParts.ts';
    import { equipmentParts } from './src/render/equipment.ts';
    globalThis.fetch = () => { throw new Error('Preparation must not fetch.'); };
    assert.equal(typeof document, 'undefined'); assert.equal(typeof window, 'undefined');
    ${source}
    console.log('private-node-check-passed');
  `,
    ],
    { cwd: root, timeout: 60000, maxBuffer: 1024 * 1024 },
  )
  expect(result.stdout.trim()).toBe('private-node-check-passed')
}

describe('private config-only CPU preparation in real Node (no browser globals)', () => {
  it('rejects malformed, unknown, future, arbitrary-transform and settings inputs', async () => {
    await check(`
      const base = defaultDesign();
      for (const invalid of [null, [], 'json', {}, { ...base, samples: 1 },
        { ...base, config: { ...base.config, schemaVersion: 5 } },
        { ...base, config: { ...base.config, catalogVersion: 'future' } },
        { ...base, config: { ...base.config, items: [] } },
        { ...base, config: { ...base.config, arrangementRef: 'container-40-review@1' } },
        { ...base, presentation: { ...base.presentation, position: [0,0,0] } },
        { ...base, presentation: { ...base.presentation, lookRef: 'unknown' } },
        { ...base, assetUrl: 'https://example.invalid/mesh' },
        { ...base, config: { ...base.config, structure: { ...base.config.structure, addons: ['roof','roof'] } } }
      ]) assert.throws(() => preparePrototypeScene(invalid));
      assert.throws(() => canonical({ invalid: NaN })); assert.throws(() => canonical({ unknown: undefined }));
      assert.equal(PREPARATION_CAPABILITIES.paidExecutionAllowed, false);
      assert.equal(PREPARATION_CAPABILITIES.renderStill, false);
    `)
  }, 60000)

  it('parses six draft fixtures and preserves semantic round trips and exact fixed mappings', async () => {
    await check(`
      const fixtures = createPrototypeFixtures(); assert.equal(fixtures.length, 6);
      assert.equal(new Set(fixtures.slice(0,4).map(f => f.design.config.product.family + f.design.config.product.lengthFt)).size, 4);
      for (const f of fixtures) {
        assert.equal(prototypeFixtureSchema.parse(f).approval, false);
        assert.throws(() => prototypeFixtureSchema.parse({ ...f, approval: true }));
        assert.throws(() => prototypeFixtureSchema.parse({ ...f, extra: 1 }));
        assert.deepEqual(deserializeDesign(serializeDesign(f.design)), f.design);
        const p = preparePrototypeScene(f.design);
        try {
          const product = f.design.config.product;
          const expected = arrangementFor(product.family, product.lengthFt);
          assert.equal(p.manifest.arrangementRef, expected.id);
          assert.deepEqual(p.manifest.equipment.map(({ id, sku, x, z, rotation }) => ({ id, sku, x, z, rotation })), expected.items);
          assert.equal(p.manifest.productionGate.allowed, false);
          assert.equal(p.manifest.productionGate.paidExecutionAllowed, false);
          assert.equal(p.manifest.renderer.artifactDigest, null);
          assert(p.manifest.reviewHolds.some(h => h.includes('Door sweeps')));
        } finally { p.dispose(); }
      }
      const interior = fixtures.find(f => f.role === 'difficult-interior');
      assert.equal(interior.design.config.appearance.mirror, true);
      assert(interior.design.presentation.lookRef.includes('night'));
      assert.equal(interior.design.config.structure.door, 'sliding');
      const structural = fixtures.find(f => f.role === 'structural-stress');
      assert.deepEqual(structural.design.config.structure.addons, ['canopy','deck','roof','stairs']);
      assert.equal(structural.design.config.structure.infill, 'glass-overhead');
      assert.equal(structural.design.presentation.doorPose, 'open');
    `)
  }, 60000)

  it('calls real builders and validates units, dimensions, matrices, visible additions and geometry bytes', async () => {
    await check(`
      for (const f of createPrototypeFixtures()) {
        const p = preparePrototypeScene(f.design), c = projectDesignToConfig(f.design);
        try {
          assert.equal(p.manifest.units.metresPerFoot, 0.3048);
          assert.equal(p.manifest.units.up, '+Y'); assert.equal(p.manifest.units.front, '+Z');
          for (const list of UNIT_LISTS) {
            const group = p.manifest.groups.find(g => g.id === 'unit/' + list.name);
            if (list.shown(c)) assert.equal(group.partCount, list.build(c).length);
            else assert.equal(group, undefined);
          }
          for (const item of p.manifest.equipment) {
            assert.equal(p.manifest.groups.find(g => g.id === 'equipment/' + item.id).partCount, equipmentParts(item.sku).length);
            assert(Math.abs(item.transform[12] - item.x) < 1e-10);
            assert.equal(item.transform[13], 0.96); assert.equal(item.transform[14], item.z);
            const theta = -item.rotation * Math.PI / 180;
            assert(Math.abs(item.transform[0] - Math.cos(theta)) < 1e-10);
            assert(Math.abs(item.transform[2] + Math.sin(theta)) < 1e-10);
            assert(item.boundsFt.min[1] >= 0.95);
            const rotated = item.rotation === 90;
            assert(item.boundsFt.size[0] <= (rotated ? item.dimensions.depthFt : item.dimensions.occupiedWidthFt) + 0.13);
          }
          const shell = p.manifest.instances.filter(i => i.group === 'unit/shell');
          assert(shell.length > 0); assert(p.manifest.instances.length > 300);
          assert(p.manifest.geometry.every(g => g.attributes.position.count > 0 && g.attributes.normal.count === g.attributes.position.count));
          assert(p.manifest.geometry.every(g => /^sha256:[a-f0-9]{64}$/.test(g.id)));
          assert(p.manifest.dimensions.assembledBoundsFt.size[0] >= c.length - 0.01);
          for (const instance of p.manifest.instances) assert(instance.matrix.every(Number.isFinite));
        } finally { p.dispose(); }
      }
    `)
  }, 60000)

  it('binds geometry, materials, camera, look, door and mirror changes without unstable UUIDs', async () => {
    await check(`
      const base = defaultDesign();
      const receipt = value => { const p = preparePrototypeScene(value); try { return p.manifest; } finally { p.dispose(); } };
      const a = receipt(base), b = receipt(JSON.parse(JSON.stringify(base)));
      assert.equal(canonical(a), canonical(b)); assert(!canonical(a).includes('uuid'));
      const paint = receipt({ ...base, config: { ...base.config, appearance: { ...base.config.appearance, finish: 'chalk' } } });
      assert.equal(a.hashes.geometry, paint.hashes.geometry); assert.notEqual(a.hashes.material, paint.hashes.material);
      const floor = receipt({ ...base, config: { ...base.config, appearance: { ...base.config.appearance, floor: 'oak' } } });
      assert.notEqual(a.hashes.material, floor.hashes.material); assert.notEqual(a.hashes.assets, floor.hashes.assets);
      const door = receipt({ ...base, presentation: { ...base.presentation, doorPose: 'open' } });
      assert.notEqual(a.hashes.geometry, door.hashes.geometry);
      const mirror = receipt({ ...base, config: { ...base.config, appearance: { ...base.config.appearance, mirror: true } } });
      assert.notEqual(a.hashes.geometry, mirror.hashes.geometry);
      const top = receipt({ ...base, presentation: { ...base.presentation, cameraRef: 'top-draft@1' } });
      assert.equal(a.hashes.geometry, top.hashes.geometry); assert.notEqual(a.hashes.camera, top.hashes.camera);
      const tall = receipt({ ...base, presentation: { ...base.presentation, aspect: 'tall' } });
      assert.notEqual(a.hashes.camera, tall.hashes.camera);
      const night = receipt({ ...base, presentation: { ...base.presentation, lookRef: 'courtyard-night-draft@1' } });
      assert.notEqual(a.hashes.look, night.hashes.look); assert.notEqual(a.preparationDigest, night.preparationDigest);
      assert.notEqual(a.hashes.geometry, receipt(defaultDesign({family:'studio', lengthFt:40})).hashes.geometry);
    `)
  }, 60000)

  it('reports actual local provenance and unsupported browser effects instead of claiming parity', async () => {
    await check(`
      const p = preparePrototypeScene(createPrototypeFixtures()[4].design);
      try {
        assert(p.manifest.materials.some(m => m.boundary === 'equipment-console-missing-canvas-pixels@1'));
        assert(p.manifest.materials.some(m => m.authoredSpec.thinGlass === true));
        assert(p.manifest.missing.some(m => m.includes('Mirror pane/frame')));
        assert(p.manifest.missing.some(m => m.includes('InteriorLights')));
        assert(p.manifest.missing.some(m => m.includes('signature')));
        assert(p.manifest.assets.every(a => a.rightsApproval === false && a.pixelDecode === 'not-performed'));
        assert(p.manifest.assets.every(a => a.files.every(f => f.status === 'present' && f.digest.startsWith('sha256:'))));
        assert(p.manifest.sources.sources.some(s => s.path === 'src/render/equipment.ts'));
        assert.equal(p.manifest.sources.rightsApproval, false);
        assert.equal(p.manifest.camera.calibration, 'existing-preview-heuristic-not-approved');
        assert.equal(p.manifest.renderer.rendererBuild, null);
        assert(Object.isFrozen(p.manifest)); assert(Object.isFrozen(p.manifest.equipment));
      } finally { p.dispose(); }
    `)
  }, 60000)

  it('owns disposable clones, isolates simultaneous preparations and fails closed after disposal', async () => {
    await check(`
      const a = preparePrototypeScene(createPrototypeFixtures()[1].design);
      const b = preparePrototypeScene(createPrototypeFixtures()[1].design);
      assert.notEqual(a.parts[0].geometry, b.parts[0].geometry);
      assert.notEqual(a.parts[0].material, b.parts[0].material);
      let geometryDisposals = 0, materialDisposals = 0, textureDisposals = 0;
      const gs = new Set(a.parts.map(p => p.geometry)), ms = new Set(a.parts.map(p => p.material));
      for (const g of gs) g.addEventListener('dispose', () => geometryDisposals++);
      for (const m of ms) { m.addEventListener('dispose', () => materialDisposals++);
        if (m.emissiveMap) m.emissiveMap.addEventListener('dispose', () => textureDisposals++);
      }
      a.dispose(); a.dispose();
      assert.equal(geometryDisposals, gs.size); assert.equal(materialDisposals, ms.size); assert.equal(textureDisposals, 1);
      assert.equal(a.disposed, true); assert.throws(() => a.parts);
      assert.equal(b.disposed, false); assert(b.parts[0].geometry.getAttribute('position').count > 0);
      b.dispose();
      const c = preparePrototypeScene(createPrototypeFixtures()[1].design);
      assert.equal(c.manifest.preparationDigest, a.manifest.preparationDigest); c.dispose();
    `)
  }, 60000)

  it('disposes owned resources when serialization fails and leaves source geometry reusable', async () => {
    await check(`
      const { BufferGeometry, Material } = await import('three');
      const originalG = BufferGeometry.prototype.dispose, originalM = Material.prototype.dispose;
      let disposedG = 0, disposedM = 0;
      BufferGeometry.prototype.dispose = function() { disposedG++; return originalG.call(this); };
      Material.prototype.dispose = function() { disposedM++; return originalM.call(this); };
      const source = equipmentParts('trainer')[0].geometry.getAttribute('position');
      const saved = source.array[0]; source.array[0] = NaN;
      try { assert.throws(() => preparePrototypeScene(defaultDesign()), /Non-finite/); }
      finally { source.array[0] = saved; BufferGeometry.prototype.dispose = originalG; Material.prototype.dispose = originalM; }
      assert(disposedG > 0); assert(disposedM > 0);
      const p = preparePrototypeScene(defaultDesign()); p.dispose();
    `)
  }, 60000)

  it('reproduces exact G1 counts and separates reference/display/engine/repetition accounting', async () => {
    await check(`
      const a = createG1ReviewBundle(), b = createG1ReviewBundle();
      assert.equal(canonical(a), canonical(b));
      assert.deepEqual(a.g1.counts, { fixtures:6, commonFixtureViews:12, additionalViews:2, namedCompositions:14, aspects:2, compositionCases:28, approvedPaidJobs:0 });
      assert.equal(new Set(a.g1.cases.map(c => c.id)).size, 28);
      for (const f of a.fixtures) {
        const cases = a.g1.cases.filter(c => c.fixtureId === f.fixture.id);
        assert.equal(cases.length, f.fixture.role === 'family-size-baseline' ? 4 : 6);
        for (const c of cases) { assert.deepEqual(parseDesign(c.design), c.design); assert.equal(c.approval, false); assert.equal(c.artifactDigest, null);
          assert.equal(c.binding.geometryDigest, f.scene.hashes.geometry); assert.equal(c.binding.cameraDigest, digest(c.camera)); }
        if (f.fixture.role === 'structural-stress') assert.equal(cases.filter(c => c.view === 'top').length, 2);
        if (f.fixture.role === 'difficult-interior') assert.equal(cases.filter(c => c.view === 'centre').length, 2);
      }
      assert.equal(a.g1.profiles.reference.requiredCompletedSamplesPerPixel, 1024);
      assert.equal(a.g1.profiles.reference.adaptiveSampling, false);
      assert.equal(a.g1.profiles.reference.lowerTierFallbackAllowed, false);
      assert.deepEqual(a.g1.profiles.reference.resolutionPx, { wide: {width:1920,height:1200}, tall: {width:1200,height:1500} });
      assert(a.g1.profiles.display.every(p => !('requiredCompletedSamplesPerPixel' in p)));
      assert.equal(a.g1.executionPlan.plannedPaidJobs, null); assert.equal(a.g1.executionPlan.repetitionsPerLane, null);
      assert.equal(a.g1.executionPlan.engineLanes.length, 3); assert.equal(a.g1.executionPlan.estimates.costCeiling, null);
    `)
  }, 60000)
})

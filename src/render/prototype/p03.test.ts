// @vitest-environment node
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const exec = promisify(execFile)
const root = fileURLToPath(new URL('../../../', import.meta.url))
async function check(source: string) {
  const run = await exec(
    process.execPath,
    [
      '--import',
      './src/render/prototype/register.ts',
      '--input-type=module',
      '-e',
      `
    import assert from 'node:assert/strict';
    import { defaultDesign, parseDesign, projectDesignToConfig } from './src/domain/design.ts';
    import { resolvePrivateThreeSceneInput, validatePrivateThreeSceneInput } from './src/render/prototype/privateScene.ts';
    import { preparePrototypeScene } from './src/render/prototype/prepare.ts';
    import { createPrototypeFixtures, createG1ReviewBundle } from './src/render/prototype/fixtures.ts';
    import { canonical, digest, bytesDigest } from './src/render/prototype/identity.ts';
    globalThis.fetch = () => { throw new Error('Preparation must not fetch.'); };
    assert.equal(typeof document, 'undefined'); assert.equal(typeof window, 'undefined');
    ${source}
    console.log('p03-check-passed');
  `,
    ],
    { cwd: root, timeout: 90000, maxBuffer: 1024 * 1024 },
  )
  expect(run.stdout.trim()).toBe('p03-check-passed')
}

describe('P03 trusted private preparation', () => {
  it('binds all eleven controls through the same recipe used by the private renderer', async () => {
    await check(`
      const { FINISHES, INTERIORS, FLOORS } = await import('./src/lib/config.ts');
      const { resolveCaptureCamera, CAPTURE_LIMITS, SAMPLE_IDS } = await import('./src/render/prototype/capture/contract.ts');
      const { P03_REQUIRED_CONTROLS } = await import('./src/render/prototype/p03Contract.ts');
      const base = defaultDesign(), first = resolvePrivateThreeSceneInput(base);
      assert.deepEqual(first.config, projectDesignToConfig(base));
      assert.deepEqual(first.controls.map(c => c.control), P03_REQUIRED_CONTROLS);
      assert.deepEqual(first.camera, resolveCaptureCamera(base));
      assert.equal(first.camera.near, 0.1); assert.equal(first.camera.far, 2000);
      assert(Object.isFrozen(first)); assert(Object.isFrozen(first.config.items));
      const mutate = fn => { const d = structuredClone(base); fn(d); return parseDesign(d); };
      const variants = [
        createPrototypeFixtures()[1].design,
        mutate(d => { d.config.structure.door = d.config.structure.door === 'sliding' ? 'hinged' : 'sliding'; }),
        mutate(d => { d.config.appearance.finish = FINISHES.find(f => f.id !== d.config.appearance.finish).id; }),
        mutate(d => { d.config.appearance.interior = INTERIORS.find(f => f.id !== d.config.appearance.interior).id; }),
        mutate(d => { d.config.appearance.floor = FLOORS.find(f => f.id !== d.config.appearance.floor).id; }),
        mutate(d => { d.config.appearance.mirror = !d.config.appearance.mirror; }),
        mutate(d => { d.presentation.lookRef = 'desert-day-draft@1'; }),
        mutate(d => { d.presentation.lookRef = 'courtyard-night-draft@1'; }),
        mutate(d => { d.presentation.doorPose = 'open'; }),
        mutate(d => { d.presentation.cameraRef = 'entry-draft@1'; }),
        mutate(d => { d.presentation.aspect = 'tall'; }),
      ];
      for (const design of variants) {
        const input = resolvePrivateThreeSceneInput(design);
        assert.notEqual(digest(input), digest(first));
        assert.deepEqual(input.config, projectDesignToConfig(design));
        assert.deepEqual(input.camera, resolveCaptureCamera(design));
        const p = preparePrototypeScene(design);
        try { assert.deepEqual(p.manifest.rendererInput, input); assert.equal(p.manifest.hashes.rendererInput, digest(input)); }
        finally { p.dispose(); }
      }
      assert.notEqual(variants[0].config.arrangementRef, base.config.arrangementRef);
      assert.equal(resolvePrivateThreeSceneInput(variants[6]).environment.id, 'desert');
      assert.equal(resolvePrivateThreeSceneInput(variants[7]).lighting.fixturesOn, true);
      assert.equal(resolvePrivateThreeSceneInput(variants[9]).view, 'interior');
      assert.equal(resolvePrivateThreeSceneInput(variants[10]).aspectRatio, 0.8);
      assert.equal(SAMPLE_IDS.length, 7); assert.equal(CAPTURE_LIMITS.attempts, 8); assert.equal(CAPTURE_LIMITS.diagnosticRetries, 3);
    `)
  }, 90000)

  it('rejects injected private reconstruction fields, unsupported inputs and non-finite values', async () => {
    await check(`
      const input = resolvePrivateThreeSceneInput(defaultDesign());
      assert.deepEqual(validatePrivateThreeSceneInput(structuredClone(input)), input);
      for (const change of [
        x => { x.config.items[0].x += 1; }, x => { x.camera.near = .05; },
        x => { x.profile.width = 1024; }, x => { x.lighting.exposure *= 2; },
        x => { x.environment.scenery = {}; }, x => { x.assetUrl = 'https://example.invalid/asset'; },
        x => { x.camera.position[0] = NaN; }, x => { delete x.controls; },
        x => { x.config.finish = 'anything'; }, x => { x.design.config.items = []; },
      ]) { const changed = structuredClone(input); change(changed); assert.throws(() => validatePrivateThreeSceneInput(changed)); }
      for (const bad of [null, [], {}, { design: { ...defaultDesign(), samples: 1 } }])
        assert.throws(() => validatePrivateThreeSceneInput(bad));
    `)
  }, 90000)

  it('fails closed for missing, changed, unauthorized and symlink assets without treating hashes as rights', async () => {
    await check(`
      const { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync } = await import('node:fs');
      const { tmpdir } = await import('node:os'); const { join } = await import('node:path');
      const { verifyPinnedFile, verifyPreparationAsset, validatePreparationAssets, PREPARATION_ASSET_INVENTORY } = await import('./src/render/prototype/assetValidation.ts');
      const { parseP03AssetValidation } = await import('./src/render/prototype/p03Contract.ts');
      const receipt = validatePreparationAssets();
      assert.equal(receipt.integrity, 'verified'); assert.equal(receipt.rights, 'held');
      assert.equal(receipt.execution.referenceDispatchAllowed, false);
      assert.equal(PREPARATION_ASSET_INVENTORY.files.length, 79);
      assert.equal(PREPARATION_ASSET_INVENTORY.rights.length, 27);
      assert.equal(receipt.holds.filter(h => h.gate === 'asset-rights').length, 28);
      assert.throws(() => parseP03AssetValidation({ ...receipt, rights: 'evidenced' }));
      assert.throws(() => parseP03AssetValidation({ ...receipt, execution: { ...receipt.execution, captureAllowed: true } }));
      for (const path of ['../package.json', 'https://example.invalid/a.webp', '/etc/passwd', 'public/textures/unknown/normal.webp'])
        assert.throws(() => verifyPreparationAsset(path));
      const sandbox = mkdtempSync(join(tmpdir(), 'p03-pins-'));
      try {
        const path = 'public/textures/test/normal.webp', bytes = Buffer.from('abcd');
        mkdirSync(join(sandbox, 'public/textures/test'), { recursive: true });
        const entry = { path, bytes: bytes.length, digest: bytesDigest(bytes) };
        assert.throws(() => verifyPinnedFile(sandbox, entry));
        writeFileSync(join(sandbox, path), bytes); assert.equal(verifyPinnedFile(sandbox, entry).digest, entry.digest);
        writeFileSync(join(sandbox, path), 'abce'); assert.throws(() => verifyPinnedFile(sandbox, entry), /hash mismatch/);
        writeFileSync(join(sandbox, path), 'abc'); assert.throws(() => verifyPinnedFile(sandbox, entry), /size mismatch/);
        rmSync(join(sandbox, path)); writeFileSync(join(sandbox, 'target'), bytes);
        symlinkSync(join(sandbox, 'target'), join(sandbox, path)); assert.throws(() => verifyPinnedFile(sandbox, entry), /symlink/);
        assert.throws(() => verifyPinnedFile(sandbox, { ...entry, path: 'public/textures/../../target' }));
      } finally { rmSync(sandbox, { recursive: true, force: true }); }
    `)
  }, 90000)

  it('prepares exact case-specific bindings and rejects weakened or forged strict reference jobs', async () => {
    await check(`
      const { validateStrictReferenceManifest } = await import('./src/render/prototype/strictReference.ts');
      const b = createG1ReviewBundle();
      assert.equal(b.caseScenes.length, 28); assert.equal(b.reference.jobs.length, 28);
      assert.equal(new Set(b.g1.cases.map(c => c.fixtureId + '/' + c.view)).size, 14);
      assert.equal(new Set(b.caseScenes.map(c => c.scene.preparationDigest)).size, 28);
      for (const c of b.g1.cases) {
        const scene = b.caseScenes.find(s => s.id === c.id).scene;
        const job = b.reference.jobs.find(j => j.id === c.id);
        assert.deepEqual(scene.design, c.design); assert.deepEqual(scene.camera, c.camera);
        assert.equal(c.binding.preparationDigest, scene.preparationDigest);
        assert.equal(job.scene.rendererInputDigest, digest(scene.rendererInput));
        assert.equal(job.width / job.height, scene.rendererInput.aspectRatio);
        assert.equal(job.execution.referenceDispatchAllowed, false);
      }
      assert.deepEqual(validateStrictReferenceManifest(b.reference, b.g1.cases), b.reference);
      for (const change of [
        r => { r.settings.requestedSamplesPerPixel = 128; },
        r => { r.settings.minimumCompletedSamplesPerPixel = 1; },
        r => { r.settings.adaptiveSampling = true; },
        r => { r.settings.nativeTimeLimitSeconds = 60; },
        r => { r.settings.lowerTierFallbackAllowed = true; },
        r => { r.settings.denoising.fallbackAllowed = true; },
        r => { r.settings.partialSuccessAllowed = true; },
        r => { r.jobs.pop(); }, r => { r.jobs[1] = r.jobs[0]; },
        r => { r.jobs[0].scene.preparationDigest = 'sha256:' + '0'.repeat(64); },
        r => { r.jobs[0].sceneFile = '../out.scene.json'; },
        r => { r.jobs[0].execution.referenceDispatchAllowed = true; },
        r => { r.jobs[0].design.presentation.aspect = 'tall'; },
        r => { r.settings.seed = 1; }, r => { r.holds = []; },
      ]) {
        const changed = structuredClone(b.reference); change(changed);
        const { manifestDigest, ...body } = changed; changed.manifestDigest = digest(body);
        assert.throws(() => validateStrictReferenceManifest(changed, b.g1.cases));
      }
    `)
  }, 90000)
})

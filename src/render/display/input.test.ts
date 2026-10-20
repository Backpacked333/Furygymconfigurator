import { describe, expect, it } from 'vitest'
import { defaultDesign, parseDesign, projectDesignToConfig } from '../../domain/design'
import { createSceneDesignFixtures } from '../../domain/designFixtures'
import { DRAFT_CAMERAS, DRAFT_LOOKS } from '../../domain/presentation'
import { resolvePrivateThreeCamera } from '../prototype/privateScene'
import { displayCameraDigest, displaySceneInput } from './input'
import { assertDisplayBrowserModule, manifestHash } from './build'
import { bindDisplay, displayProfileFor } from '../../display/contract'

describe('private full-quality input and module authority (CPU plans only)', () => {
  it('projects all six fixtures through domain authority without capture sample restrictions', () => {
    for (const fixture of createSceneDesignFixtures()) {
      const plan = displaySceneInput(fixture.design)
      expect(plan.config).toEqual(projectDesignToConfig(fixture.design))
      expect(plan.camera).toEqual(resolvePrivateThreeCamera(fixture.design))
      expect(plan.profile).toMatchObject({
        quality: 'ultra',
        backend: 'webgpu',
        temporalFrames: 40,
        postReadyFrames: 2,
      })
      expect(Object.isFrozen(plan.config.items)).toBe(true)
    }
  })
  it('accepts every named camera/aspect, retains exact fixed pixels and numerical camera digests', async () => {
    const base = defaultDesign(),
      digests = new Set<string>()
    for (const camera of DRAFT_CAMERAS)
      for (const aspect of ['wide', 'tall'] as const) {
        const design = parseDesign({
          ...base,
          presentation: { ...base.presentation, cameraRef: camera.ref, aspect },
        })
        const plan = displaySceneInput(design)
        expect([plan.profile.width, plan.profile.height]).toEqual(
          aspect === 'wide' ? [1600, 1000] : [1200, 1500],
        )
        expect(plan.view).toBe(camera.group)
        expect(plan.camera).toEqual(resolvePrivateThreeCamera(design))
        digests.add(await displayCameraDigest(design))
      }
    expect(digests.size).toBeGreaterThanOrEqual(DRAFT_CAMERAS.length)
  })
  it('supports four landscapes and Day/Night, not bespoke client lighting/camera overrides', () => {
    const base = defaultDesign(),
      environments = new Set<string>()
    for (const look of DRAFT_LOOKS) {
      const plan = displaySceneInput({
        ...base,
        presentation: { ...base.presentation, lookRef: look.ref },
      })
      expect(plan.config.environment).toBe(look.preview.environment)
      expect(plan.config.time).toBe(look.preview.time)
      environments.add(plan.config.environment)
    }
    expect(environments).toEqual(new Set(['residences', 'campus', 'desert', 'studio']))
    expect(() => displaySceneInput({ ...base, camera: { position: [0, 0, 0] } })).toThrow()
    expect(() => displaySceneInput({ ...base, width: 100, quality: 'lite' })).toThrow()
  })
  it('A→B→A projections remove addons/mirror and replace family/size/environment/items completely', () => {
    const fixtures = createSceneDesignFixtures(),
      a = fixtures[4].design,
      b = fixtures[2].design
    const first = displaySceneInput(a),
      replacement = displaySceneInput(b),
      restored = displaySceneInput(a)
    expect(first.config.mirror).toBe(true)
    expect(replacement.config.mirror).toBe(false)
    expect(replacement.config.family).not.toBe(first.config.family)
    expect(replacement.config.length).not.toBe(first.config.length)
    expect(replacement.config.items).toEqual(projectDesignToConfig(b).items)
    expect(restored).toEqual(first)
    expect(replacement.config).toEqual(projectDesignToConfig(b))
  })
  it('covers the complete four family/size × eight canonical looks × seven named cameras × two aspects contract matrix', async () => {
    const fixtures = createSceneDesignFixtures(),
      products = new Map(
        fixtures.map((f) => [
          `${f.design.config.product.family}:${f.design.config.product.lengthFt}`,
          f.design,
        ]),
      )
    expect(products.size).toBe(4)
    expect(DRAFT_LOOKS.length).toBe(8)
    expect(DRAFT_CAMERAS.length).toBe(7)
    const h = `sha256:${'a'.repeat(64)}`,
      build = {
        sourceManifestDigest: h,
        assetManifestDigest: h,
        bundleDigest: h,
        lockfileDigest: h,
        runtimePolicyDigest: h,
        threeRevision: '185',
      }
    const keys = new Set<string>()
    for (const base of products.values())
      for (const look of DRAFT_LOOKS)
        for (const camera of DRAFT_CAMERAS)
          for (const aspect of ['wide', 'tall'] as const) {
            const design = parseDesign({
              ...base,
              presentation: {
                ...base.presentation,
                lookRef: look.ref,
                cameraRef: camera.ref,
                aspect,
              },
            })
            const plan = displaySceneInput(design),
              binding = await bindDisplay(design, build)
            expect(plan.config).toEqual(projectDesignToConfig(design))
            expect(plan.camera).toEqual(resolvePrivateThreeCamera(design))
            expect(plan.profile).toEqual(displayProfileFor(design))
            expect(plan.config.items).toEqual(projectDesignToConfig(base).items)
            keys.add(binding.displayDigest)
          }
    expect(keys.size).toBe(448)
  })
  it('explicit private module allowlist rejects service/public/legacy/cloud/export/prefetch imports', () => {
    for (const name of [
      'src/render/display/browser/entry.ts',
      'src/components/StudioModel.tsx',
      'src/render/siteLight.worker.ts',
      // The material library's scan files (it never downloads early in this realm).
      'src/render/scanFiles.ts',
      'node_modules/three/build/three.webgpu.js',
    ])
      expect(() => assertDisplayBrowserModule(name)).not.toThrow()
    for (const name of [
      'src/App.tsx',
      'src/main.tsx',
      'src/image-service/display/service.ts',
      'src/render/prototype/capture/browser/scene.tsx',
      'src/render/display/backend.ts',
      'src/render/cloud.ts',
      'src/render/export.ts',
      'src/render/prefetch.ts',
      'node_modules/@aws-sdk/client-s3/index.js',
      'node_modules/playwright/index.js',
      'node_modules/react/../cloud.js',
    ])
      expect(() => assertDisplayBrowserModule(name)).toThrow()
    const record = { name: 'asset', bytes: 1, digest: 'sha256:a' }
    expect(manifestHash([record])).not.toBe(manifestHash([{ ...record, digest: 'sha256:b' }]))
  })
})

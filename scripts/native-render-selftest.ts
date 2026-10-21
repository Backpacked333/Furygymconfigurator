/** Offline preparation and coordinate assertions. No Blender, provider or network. */
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { prepareNativeClaim } from './native-render-prepare'
import { computeSetIdentity } from '../src/render-library/identity'
import { defaultDesign, parseDesign } from '../src/domain/design'
import { normalizeCustomerDesign } from '../src/render-library/views'
import { resolveNativeCamera } from '../src/render/prototype/privateScene'
import { equirectRadiance } from '../src/lib/visuals'

const fixture = JSON.parse(readFileSync('src/render-library/fixtures/worker-adapter.json', 'utf8'))
const recipe = {
  releaseId: 'fury-native-five@2' as const,
  workerBuildSha256: fixture.claim.workerBuildSha256,
  recipeBundleSha256: fixture.claim.recipeBundleSha256,
  geometrySha256: '0'.repeat(64),
  materialsSha256: '0'.repeat(64),
  camerasSha256: '0'.repeat(64),
  rendererSha256: '0'.repeat(64),
}
const base = mkdtempSync(join(tmpdir(), 'fury-native-offline-'))
const scenes = new Map<
  string,
  { count: number; sky: string | null; lights: string; geometry: string[] }
>()
try {
  for (const look of [
    'studio-day-draft@1',
    'studio-night-draft@1',
    'courtyard-day-draft@1',
    'courtyard-night-draft@1',
    'campus-day-draft@1',
    'campus-night-draft@1',
    'desert-day-draft@1',
    'desert-night-draft@1',
  ]) {
    const design = parseDesign({
      ...fixture.claim.design,
      presentation: {
        ...fixture.claim.design.presentation,
        lookRef: look,
        cameraRef: 'front-left-draft@1',
      },
    })
    const identity = await computeSetIdentity(design)
    const claim = {
      ...fixture.claim,
      design,
      identity,
      views: [
        {
          cameraRef: design.presentation.cameraRef,
          imageKey: identity.imageKeys['front-left-draft@1'],
        },
      ],
    }
    const output = join(base, look)
    const result = await prepareNativeClaim(claim, recipe, output)
    const raw = readFileSync(join(output, result.views[0].imageKey + '.json'))
    assert.equal(
      createHash('sha256').update(raw).digest('hex'),
      result.views[0].sceneManifestSha256,
    )
    const scene = JSON.parse(raw.toString())
    assert.equal(scene.width, 1920)
    assert.equal(scene.height, 1200)
    assert.equal(scene.qualification.visuallyQualified, false)
    const outside = scene.scene.objects.filter((o: { id: string }) => o.id.startsWith('scenery-'))
    if (look.startsWith('studio')) {
      assert.equal(outside.length, 0)
      assert.equal(scene.scene.environment, null)
    } else {
      assert.ok(outside.length > 40, 'authored surroundings, not a relabelled plane')
      assert.ok(
        outside.some((o: { instances?: string }) => o.instances),
        'authored vegetation instances',
      )
      assert.ok(scene.scene.environment?.blob)
      if (look.includes('-day-'))
        assert.ok(scene.scene.lights.some((l: { type: string }) => l.type === 'sun'))
      assert.ok(scene.nativeHolds.length)
    }
    scenes.set(look, {
      count: outside.length,
      sky: scene.scene.environment?.blob,
      lights: JSON.stringify(scene.scene.lights),
      geometry: outside.map((o: { geometry: string }) => o.geometry),
    })
    console.log(
      JSON.stringify({
        look,
        objects: scene.scene.objects.length,
        blobs: result.blobs,
        bytes: result.bytes,
      }),
    )
  }
  const geometries = []
  for (const name of ['courtyard', 'campus', 'desert']) {
    const day = scenes.get(name + '-day-draft@1')!,
      night = scenes.get(name + '-night-draft@1')!
    assert.ok(
      day.geometry.filter((g) => night.geometry.includes(g)).length / day.geometry.length > 0.99,
      'same authored environment; nighttime adds emissive fixtures',
    )
    assert.notEqual(day.sky, night.sky)
    assert.notEqual(day.lights, night.lights)
    geometries.push(day.geometry.join(','))
  }
  assert.equal(new Set(geometries).size, 3)
  const tallDesign = parseDesign({
    ...fixture.claim.design,
    presentation: {
      ...fixture.claim.design.presentation,
      aspect: 'tall',
      cameraRef: 'rear-left-draft@1',
    },
  })
  const tallIdentity = await computeSetIdentity(tallDesign)
  const tallClaim = {
    ...fixture.claim,
    design: tallDesign,
    identity: tallIdentity,
    views: Object.entries(tallIdentity.imageKeys).map(([cameraRef, imageKey]) => ({
      cameraRef,
      imageKey,
    })),
  }
  const tallOutput = join(base, 'all-five-tall')
  const tall = await prepareNativeClaim(tallClaim, recipe, tallOutput)
  assert.equal(tall.views.length, 5)
  assert.equal(tall.views[0].cameraRef, 'rear-left-draft@1')
  for (const view of tall.views) {
    const scene = JSON.parse(readFileSync(join(tallOutput, view.imageKey + '.json'), 'utf8'))
    assert.equal(scene.width, 1200)
    assert.equal(scene.height, 1500)
    assert.equal(scene.design.presentation.cameraRef, view.cameraRef)
  }
  for (const lengthFt of [20, 40] as const)
    for (const aspect of ['wide', 'tall'] as const) {
      const baseDesign = normalizeCustomerDesign(defaultDesign({ family: 'container', lengthFt }))
      const design = parseDesign({
        ...baseDesign,
        presentation: {
          ...baseDesign.presentation,
          aspect,
          cameraRef: 'entry-draft@1',
        },
      })
      const identity = await computeSetIdentity(design)
      const output = join(base, `container-${lengthFt}-${aspect}`)
      const result = await prepareNativeClaim(
        {
          ...fixture.claim,
          design,
          identity,
          views: [{ cameraRef: 'entry-draft@1', imageKey: identity.imageKeys['entry-draft@1'] }],
        },
        recipe,
        output,
      )
      const scene = JSON.parse(
        readFileSync(join(output, result.views[0].imageKey + '.json'), 'utf8'),
      )
      assert.equal(scene.design.presentation.doorPose, 'open')
      assert.equal(scene.design.config.product.family, 'container')
      assert.equal(
        result.views[0].cameraBindingSha256,
        createHash('sha256').update(JSON.stringify(scene.camera)).digest('hex'),
      )
      assert.ok(resolveNativeCamera(design).position[2] > 4)
    }
  // Same canonical input must produce byte-identical preparation, not just matching keys.
  for (const family of ['studio', 'container'] as const) {
    const original = normalizeCustomerDesign(defaultDesign({ family, lengthFt: 20 }))
    const changed = parseDesign({
      ...original,
      config: {
        ...original.config,
        appearance: {
          ...original.config.appearance,
          interior: 'timber',
          floor: 'oak',
          mirror: true,
        },
      },
    })
    const results = []
    for (const [index, design] of [original, changed].entries()) {
      const identity = await computeSetIdentity(design)
      results.push(
        await prepareNativeClaim(
          {
            ...fixture.claim,
            design,
            identity,
            views: [
              { cameraRef: 'rear-left-draft@1', imageKey: identity.imageKeys['rear-left-draft@1'] },
            ],
          },
          recipe,
          join(base, `shared-rear-${family}-${index}`),
        ),
      )
    }
    assert.deepEqual(results[0].views, results[1].views)
    assert.equal(results[0].bytes, results[1].bytes)
  }
  // Blender environment u=1/2-atan2(y,x)/2pi,v=1/2+asin(z)/pi.
  // Existing native mapping rotates +pi/2 around X: (x,y,z)->(x,-z,y).
  // Thus Three's azimuth and north/south are retained, with rows bottom-up.
  const width = 32,
    height = 16
  const pixels = equirectRadiance(width, height, ([x, y, z]) => [x, y, z])
  for (let row = 0; row < height; row++)
    for (let col = 0; col < width; col++) {
      const o = (row * width + col) * 4,
        [x, y, z] = pixels.slice(o, o + 3)
      const u = 0.5 - Math.atan2(-z, x) / (2 * Math.PI),
        v = 0.5 + Math.asin(y) / Math.PI
      assert.ok(Math.abs(u - (col + 0.5) / width) < 1e-6)
      assert.ok(Math.abs(v - (row + 0.5) / height) < 1e-6)
    }
  console.log(
    'All eight looks constructed; distinct authored outdoors, Day/Night sky and analytic orientation verified offline.',
  )
} finally {
  rmSync(base, { recursive: true, force: true })
}

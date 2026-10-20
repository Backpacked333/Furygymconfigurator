/** Fixed CPU entry point. Input is a service-issued claim, never a browser scene. */
import { createHash } from 'node:crypto'
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { BufferAttribute, Color, DataUtils, Matrix4 } from 'three'
import { compileCyclesConstruction, worldGeometry } from '../src/render/prototype/cycles/compile'
import { verifyPreparationAsset } from '../src/render/prototype/assetValidation'
import { TEXTURE_SETS, type TextureSet } from '../src/render/textureSets'
import type { MaterialSpec } from '../src/render/materials'
import { projectDesignToConfig, serializeDesign } from '../src/domain/design'
import { viewDesign } from '../src/render-library/views'
import {
  skyLook,
  equirectRadiance,
  environmentRadiance,
  SUN_INTENSITY,
  SUN_ANGULAR_RADIUS,
} from '../src/lib/visuals'
import { verifyWorkerClaim } from '../src/render-library/server/validation'
import { IMAGE_DIMENSIONS } from '../src/render-library/contracts'
import { nativeScenery } from './native-render-scenery'
import { resolveNativeCamera } from '../src/render/prototype/privateScene'

const hash = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex')
export async function prepareNativeClaim(
  input: unknown,
  recipe: Parameters<typeof verifyWorkerClaim>[1],
  output: string,
) {
  const claim = await verifyWorkerClaim(input, recipe)
  const config = projectDesignToConfig(claim.design)
  const scenery = nativeScenery(config)
  mkdirSync(output, { mode: 0o700 })
  const blobdir = join(output, 'blobs')
  mkdirSync(blobdir, { mode: 0o700 })
  const nativeBlobs = new Map<string, Buffer>()
  const add = (bytes: Buffer) => {
    const digest = hash(bytes)
    nativeBlobs.set(digest, bytes)
    return digest
  }
  const textures: Record<string, unknown> = {},
    materials: Record<string, unknown> = {}
  const map = (set: TextureSet, channel: 'albedo' | 'normal' | 'arm') => {
    const path = `public/textures/${set}/${channel}.webp`,
      receipt = verifyPreparationAsset(path)
    const bytes = readFileSync(path)
    if (`sha256:${hash(bytes)}` !== receipt.digest) throw Error('asset-changed')
    const size = TEXTURE_SETS[set].size
    const value = {
      blob: add(bytes),
      srgb: channel === 'albedo',
      wrap: 'repeat',
      matrix: [1 / size, 0, 0, 0, 1 / size, 0, 0, 0, 1],
    }
    const id = hash(JSON.stringify(value))
    textures[id] = value
    return id
  }
  const sceneryObjects = (parts: typeof scenery.parts) =>
    parts.map((p, i) => {
      const spec = p.material.userData.prototypeMaterial?.authoredSpec as MaterialSpec | undefined
      if (!spec) throw Error('uncaptured-native-material')
      const id = hash(JSON.stringify(spec))
      if (!materials[id]) {
        const maps: Record<string, string> = {}
        if (spec.set) {
          const info: { size: number; detailOnly?: boolean; metallic?: boolean } =
            TEXTURE_SETS[spec.set]
          if (!info) throw Error('unknown-texture')
          if (!info.detailOnly) maps.map = map(spec.set, 'albedo')
          maps.normalMap = map(spec.set, 'normal')
          maps.roughnessMap = map(spec.set, 'arm')
          if (info.metallic) maps.metalnessMap = maps.roughnessMap
        }
        materials[id] = {
          color: new Color(spec.color ?? '#ffffff').toArray(),
          roughness: spec.roughness ?? 0.6,
          metalness: spec.metalness ?? 0,
          emissive: new Color(spec.emissive ?? '#000000').toArray(),
          emissiveIntensity: spec.emissiveIntensity ?? 1,
          transmission: spec.transmission ?? 0,
          ior: spec.ior ?? 1.5,
          clearcoat: spec.clearcoat ?? 0,
          clearcoatRoughness: spec.clearcoatRoughness ?? 0.1,
          sheen: 0,
          sheenRoughness: 1,
          sheenColor: [0, 0, 0],
          specularIntensity: 1,
          specularColor: [1, 1, 1],
          opacity: 1,
          transparent: false,
          alphaTest: 0,
          side: spec.side ?? 0,
          normalScale: [spec.normalScale ?? 1, spec.normalScale ?? 1],
          maps,
        }
      }
      let instances: string | undefined
      if (p.instances) {
        const bytes = Buffer.alloc(8 + p.instances.length * 64)
        bytes.write('FRI1')
        bytes.writeUInt32LE(p.instances.length, 4)
        p.instances.forEach((m, i) =>
          m.elements.forEach((v, k) => bytes.writeFloatLE(v, 8 + i * 64 + k * 4)),
        )
        instances = add(bytes)
      }
      let geometry = p.geometry
      if (!geometry.getAttribute('uv')) {
        if (spec.set) throw Error('Textured scenery must retain authored UVs')
        geometry = geometry.clone()
        geometry.setAttribute(
          'uv',
          new BufferAttribute(new Float32Array(geometry.getAttribute('position').count * 2), 2),
        )
      }
      const bytes = worldGeometry(geometry, p.matrix)
      if (geometry !== p.geometry) geometry.dispose()
      return {
        id: `scenery-${i}`,
        geometry: add(bytes),
        matrix: new Matrix4().toArray(),
        materials: [id],
        ...(instances ? { instances } : {}),
      }
    })
  let environment: { blob: string } | null = null
  const lights: Record<string, unknown>[] = []
  if (config.environment !== 'studio') {
    const look = skyLook(config.environment, config.time),
      width = 1024,
      height = 512
    const pixels = equirectRadiance(width, height, (d) => environmentRadiance(d, look))
    const bytes = Buffer.alloc(12 + width * height * 6)
    bytes.write('FRE1')
    bytes.writeUInt32LE(width, 4)
    bytes.writeUInt32LE(height, 8)
    for (let i = 0; i < width * height; i++)
      for (let c = 0; c < 3; c++)
        bytes.writeUInt16LE(
          DataUtils.toHalfFloat(Math.max(0, Math.min(65000, pixels[i * 4 + c]))),
          12 + i * 6 + c * 2,
        )
    environment = { blob: add(bytes) }
    if (look.sunlight.intensity > 1e-4)
      lights.push({
        type: 'sun',
        color: look.sunlight.color,
        direction: look.sunlight.direction,
        irradiance: SUN_INTENSITY * look.sunlight.intensity,
        angle: SUN_ANGULAR_RADIUS * 2,
      })
  }
  const views = [...claim.views].sort(
    (a, b) =>
      Number(b.cameraRef === claim.design.presentation.cameraRef) -
      Number(a.cameraRef === claim.design.presentation.cameraRef),
  )
  const manifests = []
  const sceneries = new Map<string, { scenery: typeof scenery; objects: unknown[] }>()
  for (const view of views) {
    // The interior view renders the interior-visible design, so its pixels match its shared key.
    const design = viewDesign(claim.design, view.cameraRef)
    const sceneryKey = serializeDesign({
      ...design,
      presentation: { ...design.presentation, cameraRef: claim.design.presentation.cameraRef },
    })
    let viewScenery = sceneries.get(sceneryKey)
    if (!viewScenery) {
      const parts =
        sceneryKey === serializeDesign(claim.design)
          ? scenery
          : nativeScenery(projectDesignToConfig(design))
      viewScenery = { scenery: parts, objects: sceneryObjects(parts.parts) }
      sceneries.set(sceneryKey, viewScenery)
    }
    const compiled = compileCyclesConstruction(design, resolveNativeCamera(design))
    for (const [key, blob] of compiled.blobs) nativeBlobs.set(key, blob.bytes)
    const { width, height } = IMAGE_DIMENSIONS[design.presentation.aspect]
    const scene = {
      ...compiled.manifest.scene,
      objects: [...compiled.manifest.scene.objects, ...viewScenery.objects],
      materials: { ...compiled.manifest.scene.materials, ...materials },
      textures: { ...compiled.manifest.scene.textures, ...textures },
      lights,
      environment,
    }
    const cameraBindingSha256 = hash(JSON.stringify(compiled.manifest.camera))
    const body = {
      ...compiled.manifest,
      status: 'native-draft-unqualified',
      width,
      height,
      scene,
      environmentId: config.environment,
      time: config.time,
      nativeHolds: viewScenery.scenery.holds,
      qualification: {
        visuallyQualified: false,
        strictReference: false,
        productionApproved: false,
      },
      imageKey: view.imageKey,
      cameraBindingSha256,
      view,
      workerBuildSha256: claim.workerBuildSha256,
      recipeBundleSha256: claim.recipeBundleSha256,
    }
    const bytes = Buffer.from(JSON.stringify(body)),
      sceneManifestSha256 = hash(bytes)
    writeFileSync(join(output, `${view.imageKey}.json`), bytes, { flag: 'wx', mode: 0o600 })
    manifests.push({
      cameraRef: view.cameraRef,
      imageKey: view.imageKey,
      sceneManifestSha256,
      cameraBindingSha256,
    })
  }
  let total = 0
  for (const [key, bytes] of nativeBlobs) {
    total += bytes.length
    if (total > 512 * 1024 * 1024) throw Error('package-too-large')
    writeFileSync(join(blobdir, key), bytes, { flag: 'wx', mode: 0o600 })
  }
  writeFileSync(
    join(output, 'job.json'),
    JSON.stringify({
      claim,
      views: manifests,
      blobs: [...nativeBlobs].map(([sha256, b]) => ({ sha256, bytes: b.length })),
    }),
    { flag: 'wx', mode: 0o600 },
  )
  for (const g of new Set(scenery.parts.map((p) => p.geometry))) g.dispose()
  return { views: manifests, blobs: nativeBlobs.size, bytes: total, holds: scenery.holds }
}

if (process.argv[1] && resolve(process.argv[1]) === resolve('scripts/native-render-prepare.ts')) {
  const [claimFile, recipeFile, output] = process.argv.slice(2)
  if (!claimFile || !recipeFile || !output)
    throw Error('Expected claim, registered recipe, fresh output directory')
  console.log(
    JSON.stringify(
      await prepareNativeClaim(
        JSON.parse(readFileSync(claimFile, 'utf8')),
        JSON.parse(readFileSync(recipeFile, 'utf8')),
        output,
      ),
    ),
  )
}

import { createHash } from 'node:crypto'
import { mkdirSync, realpathSync, writeFileSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { BufferGeometry, Color, Matrix4, PerspectiveCamera } from 'three'
import { preparePrototypeScene } from '../prepare'
import { canonical, digest } from '../identity'
import { verifyPreparationAsset } from '../assetValidation'
import { STRICT_REFERENCE_SETTINGS } from '../strictReference'
import { P03_EXECUTION_POLICY } from '../p03Contract'
import { TEXTURE_SETS, type TextureSet } from '../../textureSets'
import type { MaterialSpec } from '../../materials'

const ROOT = fileURLToPath(new URL('../../../../', import.meta.url))
const hex = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')
const identity = new Matrix4().toArray()

/** FRG1 in world feet. Mirrored transforms keep front faces and custom normals consistent. */
export function worldGeometry(source: BufferGeometry, matrix: Matrix4): Buffer {
  const geometry = source.clone().applyMatrix4(matrix)
  try {
    const position = geometry.getAttribute('position')
    const indices = geometry.index
      ? Uint32Array.from(geometry.index.array)
      : Uint32Array.from({ length: position.count }, (_, i) => i)
    if (indices.length % 3) throw new Error('Non-triangle geometry.')
    if (matrix.determinant() < 0)
      for (let i = 0; i < indices.length; i += 3)
        [indices[i + 1], indices[i + 2]] = [indices[i + 2], indices[i + 1]]
    const chunks: Buffer[] = []
    let offset = 0
    const add = (data: Float32Array | Uint32Array) => {
      const start = offset
      const bytes = Buffer.from(data.buffer, data.byteOffset, data.byteLength)
      if ([...data].some((value) => !Number.isFinite(value))) throw new Error('Invalid geometry.')
      chunks.push(bytes)
      offset += bytes.length
      return start
    }
    const attribute = (name: string, size: number) => {
      const value = geometry.getAttribute(name)
      if (!value || value.itemSize !== size || value.count !== position.count)
        throw new Error('Incomplete geometry attributes.')
      return add(Float32Array.from(value.array))
    }
    const header = {
      count: position.count,
      position: attribute('position', 3),
      normal: attribute('normal', 3),
      uv: attribute('uv', 2),
      index: { offset: add(indices), count: indices.length },
      groups: geometry.groups.map((g) => [
        g.start,
        Math.min(g.count, indices.length - g.start),
        g.materialIndex ?? 0,
      ]),
    }
    const json = Buffer.from(JSON.stringify(header))
    const padded = Buffer.alloc(Math.ceil(json.length / 4) * 4, 32)
    json.copy(padded)
    const prefix = Buffer.alloc(8)
    prefix.write('FRG1')
    prefix.writeUInt32LE(padded.length, 4)
    return Buffer.concat([prefix, padded, ...chunks])
  } finally {
    geometry.dispose()
  }
}

export function compileCyclesConstruction(design: unknown) {
  const prepared = preparePrototypeScene(design)
  const blobs = new Map<string, { bytes: Buffer; kind: 'geometry' | 'texture' }>()
  const add = (bytes: Buffer, kind: 'geometry' | 'texture') => {
    if (bytes.length > 64 * 1024 * 1024) throw new Error('Conversion blob too large.')
    const key = hex(bytes)
    blobs.set(key, { bytes, kind })
    return key
  }
  try {
    const textures: Record<
      string,
      { blob: string; srgb: boolean; wrap: 'repeat'; matrix: number[] }
    > = {}
    const map = (set: TextureSet, channel: 'albedo' | 'normal' | 'arm') => {
      const name = `public/textures/${set}/${channel}.webp`
      const verified = verifyPreparationAsset(name)
      const bytes = readFileSync(join(ROOT, name))
      if (`sha256:${hex(bytes)}` !== verified.digest)
        throw new Error('Texture changed during conversion.')
      const info = TEXTURE_SETS[set]
      const texture = {
        blob: add(bytes, 'texture'),
        srgb: channel === 'albedo',
        wrap: 'repeat' as const,
        matrix: [1 / info.size, 0, 0, 0, 1 / info.size, 0, 0, 0, 1],
      }
      const key = digest(texture)
      textures[key] = texture
      return key
    }
    const materials = Object.fromEntries(
      prepared.manifest.materials.map((entry) => {
        const spec = entry.authoredSpec as MaterialSpec & {
          colorLinear?: number[]
          emissiveLinear?: number[]
        }
        const rgb = (value: MaterialSpec['color'], fallback: string) =>
          new Color(value ?? fallback).toArray()
        const maps: Record<string, string> = {}
        if (spec.set) {
          if (!Object.hasOwn(TEXTURE_SETS, spec.set)) throw new Error('Unregistered texture set.')
          const info: { size: number; detailOnly?: boolean; metallic?: boolean } =
            TEXTURE_SETS[spec.set]
          if (!info.detailOnly) maps.map = map(spec.set, 'albedo')
          maps.normalMap = map(spec.set, 'normal')
          maps.roughnessMap = map(spec.set, 'arm')
          if (info.metallic) maps.metalnessMap = maps.roughnessMap
        }
        const physical =
          spec.clearcoat !== undefined ||
          spec.sheen !== undefined ||
          spec.transmission !== undefined ||
          spec.specularIntensity !== undefined
        return [
          entry.id,
          {
            color: spec.thinGlass ? [1, 1, 1] : (spec.colorLinear ?? rgb(spec.color, '#ffffff')),
            roughness: spec.thinGlass ? 0 : (spec.roughness ?? (spec.set ? 1 : 0.6)),
            metalness: spec.metalness ?? 0,
            emissive: spec.emissiveLinear ?? rgb(spec.emissive, '#000000'),
            emissiveIntensity: spec.emissiveIntensity ?? 1,
            transmission: spec.thinGlass ? 1 : (spec.transmission ?? 0),
            ior: spec.ior ?? 1.5,
            clearcoat: spec.clearcoat ?? 0,
            clearcoatRoughness: spec.clearcoatRoughness ?? (physical ? 0.1 : 0),
            sheen: spec.sheen ?? 0,
            sheenRoughness: spec.sheenRoughness ?? (physical ? 0.6 : 1),
            sheenColor: rgb(spec.sheenColor, '#000000'),
            specularIntensity: spec.specularIntensity ?? 1,
            specularColor: [1, 1, 1],
            opacity: spec.opacity ?? 1,
            transparent: spec.thinGlass ? false : (spec.transparent ?? false),
            alphaTest: 0,
            side: spec.side ?? 0,
            normalScale: [spec.normalScale ?? 1, spec.normalScale ?? 1],
            maps,
          },
        ]
      }),
    )
    const objects = prepared.parts.map((part, i) => ({
      id: prepared.manifest.instances[i].id,
      geometry: add(worldGeometry(part.geometry, part.matrix), 'geometry'),
      matrix: identity,
      materials: [prepared.manifest.instances[i].materialId],
    }))
    const camera = prepared.manifest.rendererInput.camera
    const pose = new PerspectiveCamera(camera.fov)
    pose.position.fromArray(camera.position)
    pose.up.fromArray(camera.up)
    pose.lookAt(camera.target[0], camera.target[1], camera.target[2])
    pose.updateMatrixWorld(true)
    const size =
      STRICT_REFERENCE_SETTINGS.resolutionPx[prepared.manifest.design.presentation.aspect]
    const body = {
      contract: 'fury.cycles-construction@1',
      status: 'incomplete-conversion-no-render',
      execution: P03_EXECUTION_POLICY,
      preparationDigest: prepared.manifest.preparationDigest,
      assetValidation: prepared.manifest.assetValidation,
      sourceDigest: prepared.manifest.hashes.sources,
      design: prepared.manifest.design,
      units: prepared.manifest.units,
      settings: STRICT_REFERENCE_SETTINGS,
      ...size,
      camera: {
        matrix: pose.matrixWorld.toArray(),
        fov: camera.fov,
        near: camera.near,
        far: camera.far,
      },
      exposure: prepared.manifest.rendererInput.lighting.exposure,
      scene: { objects, materials, textures, lights: [], environment: null },
      blobs: [...blobs]
        .map(([hash, item]) => ({ hash, kind: item.kind, bytes: item.bytes.length }))
        .sort((a, b) => (a.hash < b.hash ? -1 : 1)),
      holds: [
        'Construction test only: no rendering, paid execution or production admission.',
        'World/environment, scenery and interior fixture conversion are not implemented; no default sky/light is substituted.',
        'Equipment console and signature font pixels are missing; material holders are not complete authored pixels.',
        'Mirror, glass, surface normals/UVs, photometry and finishing need rendered parity review.',
        'Completed-sample evidence, worker shutdown and rights clearance remain required.',
        ...prepared.manifest.reviewHolds,
      ],
    }
    if (body.blobs.reduce((sum, b) => sum + b.bytes, 0) > 512 * 1024 * 1024)
      throw new Error('Conversion package too large.')
    const bytes = Buffer.from(canonical(body))
    return { manifest: body, bytes, digest: `sha256:${hex(bytes)}`, blobs }
  } finally {
    prepared.dispose()
  }
}

/** Caller-owned fresh directory only; no overwrite, network, renderer or legacy history access. */
export function writeCyclesConstruction(design: unknown, destination: string) {
  const target = resolve(destination)
  if (realpathSync(dirname(target)) !== dirname(target)) throw new Error('Symlink output parent.')
  const compiled = compileCyclesConstruction(design)
  mkdirSync(target, { mode: 0o700 })
  mkdirSync(join(target, 'blobs'), { mode: 0o700 })
  for (const [hash, value] of compiled.blobs)
    writeFileSync(join(target, 'blobs', hash), value.bytes, { flag: 'wx', mode: 0o600 })
  writeFileSync(join(target, 'manifest.json'), compiled.bytes, { flag: 'wx', mode: 0o600 })
  return {
    digest: compiled.digest,
    objects: compiled.manifest.scene.objects.length,
    blobs: compiled.blobs.size,
  }
}

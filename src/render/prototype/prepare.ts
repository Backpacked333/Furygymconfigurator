import { endianness } from 'node:os'
import { z } from 'zod'
import {
  Box3,
  BufferAttribute,
  BufferGeometry,
  Material,
  MeshPhysicalMaterial,
  PlaneGeometry,
  Texture,
  Vector3,
  REVISION,
} from 'three'
import {
  parseDesign,
  projectDesignToConfig,
  resolveDesignManifest,
  freezeDesignValue,
} from '../../domain/design'
import { productHeight } from '../../lib/config'
import { UNIT_LISTS } from '../unitParts'
import { equipmentParts } from '../equipment'
import { box } from '../geometry'
import { compose, part, place, type Part } from '../parts'
import { FLOOR_Y, interiorBounds } from '../envelope'
import { material, MATERIAL_CAPTURE_VERSION } from './materialCapture'
import { bytesDigest, digest } from './identity'
import { sourceProvenance, textureProvenance, validatePreparationAssets } from './provenance'
import { resolvePrivateThreeSceneInput } from './privateScene'
import { P03_EXECUTION_POLICY, P03_PREPARATION_PROTOCOL } from './p03Contract'

const loadedSourceIdentity = sourceProvenance().digest

export const PREPARATION_CAPABILITIES = freezeDesignValue({
  contract: 'fury.prototype-scene-preparation',
  version: 2,
  status: 'DRAFT-config-only-private-reconstruction',
  approval: false,
  productionAllowed: false,
  paidExecutionAllowed: false,
  rendererQualified: false,
  cpuGeometry: true,
  materialSpecifications: true,
  privateReconstructionInstructions: true,
  browserSceneSerialization: false,
  renderStill: false,
  capture: false,
  stream: false,
  textureDecode: false,
  resourceOwnership: 'owned-clones-disposed-explicitly; source-caches-live-until-process-exit',
})

const unsupported = [
  'No GPU renderer, delivered pixels, image artifact, capture, streaming or strict-reference execution.',
  'Material specifications only: no texture decode/upload, TSL thin-glass shader, parallax/site/interior probes or measured PBR calibration.',
  'Equipment console canvas pixels are unavailable; geometry and scalar console material are retained with an explicit missing-pixels receipt.',
  'Mirror pane/frame geometry only; planar/ray-traced reflections and useMirror render targets are unsupported.',
  'Studio signature plane geometry only; browser canvas lettering/texture is unavailable.',
  'CPU parts exclude environment and InteriorLights fixture meshes; full private reconstruction consumes bound config through authored Atmosphere/Landscape/StudioModel/probes. Photometry and pixel parity remain unqualified.',
  'Camera calculations reuse gallery heuristics (including scenery keep-outs); neither environments nor resulting framing are art-approved.',
  'Lite exposure, AgX and sRGB are bound. Bloom/path-tracing/denoising are absent; white balance, finishing and responsive framing require art review.',
] as const

function bounds(parts: readonly Part[]) {
  const result = new Box3()
  for (const p of parts) {
    p.geometry.computeBoundingBox()
    result.union(p.geometry.boundingBox!.clone().applyMatrix4(p.matrix))
  }
  if (result.isEmpty()) throw new Error('An empty geometry assembly is not a scene.')
  return {
    min: result.min.toArray(),
    max: result.max.toArray(),
    size: result.getSize(new Vector3()).toArray(),
  }
}

function attributeReceipt(attribute: BufferAttribute) {
  if (!(attribute instanceof BufferAttribute))
    throw new Error('Interleaved attributes require a separately qualified adapter.')
  for (const value of attribute.array)
    if (!Number.isFinite(value)) throw new Error('Non-finite geometry attribute.')
  return {
    componentType: attribute.array.constructor.name,
    itemSize: attribute.itemSize,
    count: attribute.count,
    normalized: attribute.normalized,
    byteOrder: 'little-endian',
    digest: bytesDigest(
      new Uint8Array(
        attribute.array.buffer,
        attribute.array.byteOffset,
        attribute.array.byteLength,
      ),
    ),
  }
}
function geometryReceipt(geometry: BufferGeometry) {
  if (Object.keys(geometry.morphAttributes).length)
    throw new Error('Morph geometry is unsupported.')
  const attributes = Object.fromEntries(
    Object.entries(geometry.attributes)
      .sort(([a], [b]) => (a < b ? -1 : 1))
      .map(([name, attribute]) => [name, attributeReceipt(attribute as BufferAttribute)]),
  )
  if (!attributes.position || !attributes.normal || !attributes.uv)
    throw new Error('Required geometry attributes are missing.')
  geometry.computeBoundingBox()
  const body = {
    attributes,
    index: geometry.index ? attributeReceipt(geometry.index) : null,
    groups: geometry.groups,
    boundsFt: {
      min: geometry.boundingBox!.min.toArray(),
      max: geometry.boundingBox!.max.toArray(),
    },
  }
  return { id: digest(body), ...body }
}
function materialReceipt(value: Material): {
  id: string
  boundary: string
  authoredSpec: Record<string, unknown>
} {
  const captured = value.userData.prototypeMaterial as
    { boundary: string; authoredSpec: Record<string, unknown> } | undefined
  if (captured?.boundary === MATERIAL_CAPTURE_VERSION) return { id: digest(captured), ...captured }
  const canvas = z
    .object({
      width: z.number().int().positive(),
      height: z.number().int().positive(),
      prototypeMissingPixels: z.literal(true),
    })
    .safeParse(value instanceof MeshPhysicalMaterial ? value.emissiveMap?.image : null)
  if (value instanceof MeshPhysicalMaterial && canvas.success) {
    const body = {
      boundary: 'equipment-console-missing-canvas-pixels@1',
      authoredSpec: {
        colorLinear: value.color.toArray(),
        emissiveLinear: value.emissive.toArray(),
        emissiveIntensity: value.emissiveIntensity,
        roughness: value.roughness,
        clearcoat: value.clearcoat,
        clearcoatRoughness: value.clearcoatRoughness,
        canvas: { width: canvas.data.width, height: canvas.data.height, pixels: null },
      },
    }
    return { id: digest(body), ...body }
  }
  throw new Error(
    'Unrecognized material: start this adapter with its private Node register.ts loader.',
  )
}

type PartGroup = { id: string; source: string; parts: Part[] }

/** Synchronous, CPU-only. Requires private register.ts loader; never call from the web app. */
export function preparePrototypeScene(input: unknown) {
  if (typeof window !== 'undefined' || endianness() !== 'LE')
    throw new Error('Private little-endian Node preparation only.')
  const design = parseDesign(input)
  const config = projectDesignToConfig(design)
  const resolved = resolveDesignManifest(design)
  const ownedGeometry = new Map<BufferGeometry, BufferGeometry>()
  const ownedMaterials = new Map<Material, Material>()
  const ownedTextures = new Set<Texture>()
  const temporaryGeometry: BufferGeometry[] = []
  let disposed = false
  let heldParts: Part[] = []
  const dispose = () => {
    if (disposed) return
    disposed = true
    ownedGeometry.forEach((geometry) => geometry.dispose())
    ownedMaterials.forEach((value) => value.dispose())
    ownedTextures.forEach((texture) => texture.dispose())
    temporaryGeometry.forEach((geometry) => geometry.dispose())
    ownedGeometry.clear()
    ownedMaterials.clear()
    ownedTextures.clear()
    temporaryGeometry.length = 0
    heldParts = []
  }
  try {
    const groups: PartGroup[] = UNIT_LISTS.filter((list) => list.shown(config)).map((list) => ({
      id: `unit/${list.name}`,
      source: 'src/render/unitParts.ts',
      parts: list.build(config),
    }))
    const equipment = config.items.map((item) => {
      const transform = compose([item.x, FLOOR_Y, item.z], [0, (-item.rotation * Math.PI) / 180, 0])
      const parts = equipmentParts(item.sku).map((p) => ({
        ...p,
        matrix: transform.clone().multiply(p.matrix),
      }))
      groups.push({ id: `equipment/${item.id}`, source: 'src/render/equipment.ts', parts })
      return {
        ...item,
        dimensions: resolved.arrangement.items.find((entry) => entry.id === item.id)!.dimensions,
        transform: transform.toArray(),
        boundsFt: bounds(parts),
      }
    })
    const extras: Part[] = []
    if (config.mirror) {
      const width = config.length * 0.48,
        height = 5.8
      const frameMaterial = material({
        set: 'powder_coat',
        color: '#161716',
        roughness: 0.62,
        normalScale: 0.35,
        interior: true,
      })
      const pane = new PlaneGeometry(width, height)
      temporaryGeometry.push(pane)
      extras.push(
        ...place(
          [
            part(box(width + 0.1, 0.05, 0.06), frameMaterial, [0, height / 2 + 0.025, -0.02]),
            part(box(width + 0.1, 0.05, 0.06), frameMaterial, [0, -height / 2 - 0.025, -0.02]),
            part(box(0.05, height + 0.1, 0.06), frameMaterial, [-width / 2 - 0.025, 0, -0.02]),
            part(box(0.05, height + 0.1, 0.06), frameMaterial, [width / 2 + 0.025, 0, -0.02]),
            part(
              pane,
              material({ color: '#ffffff', metalness: 1, roughness: 0 }),
              undefined,
              undefined,
              undefined,
              false,
            ),
          ],
          [-config.length * 0.16, 4.9, interiorBounds(config).back + 0.04],
        ),
      )
    }
    if (config.family === 'studio') {
      const plane = new PlaneGeometry(5.6 * 0.8, 0.32 * 0.8)
      temporaryGeometry.push(plane)
      extras.push(
        part(
          plane,
          material({ transparent: true, depthWrite: false, roughness: 0.35, metalness: 0.6 }),
          [-config.length / 2 + 4.2, 10.15, 4.006],
          undefined,
          undefined,
          false,
        ),
      )
    }
    if (extras.length)
      groups.push({
        id: 'browser-boundary-geometry',
        source: 'src/components/StudioModel.tsx',
        parts: extras,
      })

    const geometries = new Map<string, ReturnType<typeof geometryReceipt>>()
    const materials = new Map<string, ReturnType<typeof materialReceipt>>()
    const geometryIds = new Map<BufferGeometry, string>()
    const materialIds = new Map<Material, string>()
    const instances = groups.flatMap((group) =>
      group.parts.map((original, index) => {
        if (
          original.matrix.elements.some((value) => !Number.isFinite(value)) ||
          original.matrix.determinant() === 0
        )
          throw new Error('Invalid geometry transform.')
        let geometry = ownedGeometry.get(original.geometry)
        if (!geometry) {
          geometry = original.geometry.clone()
          ownedGeometry.set(original.geometry, geometry)
        }
        let value = ownedMaterials.get(original.material)
        if (!value) {
          value = original.material.clone()
          ownedMaterials.set(original.material, value)
          for (const [key, texture] of Object.entries(value))
            if (texture instanceof Texture) {
              const clone = texture.clone()
              ownedTextures.add(clone)
              Object.assign(value, { [key]: clone })
            }
        }
        const prepared = { ...original, geometry, material: value, matrix: original.matrix.clone() }
        heldParts.push(prepared)
        let geometryId = geometryIds.get(geometry)
        if (!geometryId) {
          const entry = geometryReceipt(geometry)
          geometryId = entry.id
          geometryIds.set(geometry, entry.id)
          geometries.set(entry.id, entry)
        }
        let materialId = materialIds.get(value)
        if (!materialId) {
          const entry = materialReceipt(value)
          materialId = entry.id
          materialIds.set(value, entry.id)
          materials.set(entry.id, entry)
        }
        return {
          id: `${group.id}/${index}`,
          group: group.id,
          source: group.source,
          geometryId,
          materialId,
          matrix: prepared.matrix.toArray(),
          castsShadow: prepared.shadow,
          negativeDeterminant: prepared.matrix.determinant() < 0,
        }
      }),
    )
    const materialList = [...materials.values()].sort((a, b) => (a.id < b.id ? -1 : 1))
    const textureSets = materialList.flatMap((entry) =>
      typeof entry.authoredSpec.set === 'string' ? [entry.authoredSpec.set] : [],
    )
    const assetValidation = validatePreparationAssets()
    const sources = sourceProvenance()
    if (sources.digest !== loadedSourceIdentity)
      throw new Error('Preparation sources changed after module load.')
    const assets = textureProvenance(textureSets)
    const rendererInput = resolvePrivateThreeSceneInput(design)
    const camera = {
      ref: resolved.camera.ref,
      ...rendererInput.camera,
      aspectClass: design.presentation.aspect,
      aspectRatio: rendererInput.aspectRatio,
      nearFt: rendererInput.camera.near,
      farFt: rendererInput.camera.far,
      fovUnit: 'vertical-degrees',
      calibration: 'existing-preview-heuristic-not-approved',
    }
    const hashes = {
      geometry: digest(
        instances.map(({ geometryId, matrix, castsShadow }) => ({
          geometryId,
          matrix,
          castsShadow,
        })),
      ),
      material: digest({
        materials: materialList,
        bindings: instances.map(({ id, materialId }) => ({ id, materialId })),
      }),
      camera: digest(camera),
      look: digest(resolved.look),
      assets: digest(assets),
      sources: sources.digest,
      cpuReceipt: digest({
        geometry: [...geometries.values()],
        materials: materialList,
        instances,
      }),
      rendererInput: digest(rendererInput),
      assetValidation: digest(assetValidation),
    }
    const body = {
      protocol: P03_PREPARATION_PROTOCOL,
      execution: P03_EXECUTION_POLICY,
      capabilities: PREPARATION_CAPABILITIES,
      rendererInput,
      assetValidation,
      design,
      approval: false as const,
      productionGate: resolved.productionGate,
      units: {
        length: 'feet',
        metresPerFoot: 0.3048,
        centimetresPerFoot: 30.48,
        handedness: 'right',
        up: '+Y',
        front: '+Z',
        lengthAxis: '+X',
        origin: 'unit-centre-at-ground',
        floorY: FLOOR_Y,
        matrixStorage: 'column-major',
        placement: 'world = translation(x,FLOOR_Y,z) * rotationY(-degrees) * localPart',
        normalTransform: 'inverse-transpose of world linear transform',
        winding:
          'reverse winding after baking negative-determinant transforms; do not silently drop mirrored parts',
        uv: 'existing procedural UVs measured in feet; tangent generation not qualified',
      },
      dimensions: {
        lengthFt: config.length,
        nominalDepthFt: 8,
        nominalHeightFt: productHeight(config),
        interior: interiorBounds(config),
        assembledBoundsFt: bounds(heldParts),
        calibration: 'source-parameter-dimensions-only; not manufacturer/engineering survey',
      },
      arrangementRef: design.config.arrangementRef,
      equipment,
      groups: groups.map((group) => ({
        id: group.id,
        source: group.source,
        partCount: group.parts.length,
      })),
      geometry: [...geometries.values()].sort((a, b) => (a.id < b.id ? -1 : 1)),
      materials: materialList,
      instances,
      camera,
      look: resolved.look,
      doorPose: design.presentation.doorPose,
      assets,
      sources,
      hashes,
      renderer: { threeRevision: REVISION, rendererBuild: null, artifactDigest: null },
      missing: [...unsupported, ...rendererInput.deferred],
      reviewHolds: [
        ...resolved.productionGate.reviewHolds,
        'Asset ownership/distribution/cloud/stream/export rights remain unverified.',
        'Geometry topology, UV/tangent quality, actual access, camera and light calibration require independent review.',
      ],
    }
    const manifest = freezeDesignValue({ ...body, preparationDigest: digest(body) })
    return {
      manifest,
      get disposed() {
        return disposed
      },
      get parts() {
        if (disposed) throw new Error('Prepared resources have been disposed.')
        return heldParts
      },
      dispose,
    }
  } catch (error) {
    dispose()
    throw error
  }
}

export type PreparedPrototypeScene = ReturnType<typeof preparePrototypeScene>
export type PreparationManifest = PreparedPrototypeScene['manifest']

export const prototypePreparationAdapter = Object.freeze({
  capabilities: PREPARATION_CAPABILITIES,
  prepare: preparePrototypeScene,
})

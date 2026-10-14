import process from 'node:process'
import { readFile, writeFile, stat } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { fileURLToPath, URL } from 'node:url'
import { resolve, sep } from 'node:path'
import { setImmediate } from 'node:timers/promises'
import { createServer } from 'vite'
import { JSDOM } from 'jsdom'
import { Mesh, Texture, TextureLoader } from 'three'
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js'

// CPU geometry/material-slot measurement ONLY: pixels are intentionally not decoded or rendered.
// node src/dev/asset-pilot/measure-models.mjs /outside/repo/assets
if (process.argv.length !== 3) throw new Error('Expected the prepare-model output directory.')
const root = fileURLToPath(new URL('../../../', import.meta.url))
const output = resolve(process.argv[2])
if (output === resolve(root) || output.startsWith(resolve(root) + sep))
  throw new Error('Write measurements outside the repository.')
const manifest = JSON.parse(await readFile(new URL('./provenance.json', import.meta.url)))
const dom = new JSDOM('')
const previousDocument = globalThis.document
globalThis.document = dom.window.document
dom.window.HTMLCanvasElement.prototype.getContext = () => null
const originalLoad = TextureLoader.prototype.loadAsync
const placeholders = []
TextureLoader.prototype.loadAsync = async function (url) {
  const texture = new Texture()
  texture.name = url
  placeholders.push(texture)
  return texture
}
const loader = new GLTFLoader()
loader.register(() => ({
  name: 'Q11_CPU_ONLY_SKIP_IMAGE_DECODE',
  loadTexture: async () => {
    const texture = new Texture()
    placeholders.push(texture)
    return texture
  },
}))
const server = await createServer({
  root,
  configFile: false,
  server: { middlewareMode: true },
  appType: 'custom',
  optimizeDeps: { noDiscovery: true, include: [] },
})
let releaseBatches = () => {}
try {
  const { createPilotModel, measuredBounds } = await server.ssrLoadModule(
    '/src/dev/asset-pilot/modelAdapter.ts',
  )
  const { equipmentParts } = await server.ssrLoadModule('/src/render/equipment.ts')
  const { batch, measureParts, disposeBatches } = await server.ssrLoadModule('/src/render/parts.ts')
  const parts = equipmentParts('bike')
  const batches = batch(parts)
  releaseBatches = () => disposeBatches(batches)
  await setImmediate()
  const geometryBytes = (geometry) => {
    const arrays = new Set(
      Object.values(geometry.attributes).map((a) =>
        a.isInterleavedBufferAttribute ? a.data.array : a.array,
      ),
    )
    if (geometry.index) arrays.add(geometry.index.array)
    return [...arrays].reduce((total, array) => total + array.byteLength, 0)
  }
  const texturePaths = [
    ...new Set(
      batches.flatMap(({ material }) =>
        Object.values(material)
          .filter((v) => v?.isTexture && v.name.includes('textures/'))
          .map((t) => t.name.slice(t.name.indexOf('textures/'))),
      ),
    ),
  ].sort()
  const baselineMaps = await Promise.all(
    texturePaths.map(async (path) => ({
      path,
      bytes: (await stat(resolve(root, 'public', path))).size,
    })),
  )
  const signature = (scene) => {
    const meshes = []
    scene.traverse((o) => {
      if (!(o instanceof Mesh)) return
      const materials = Array.isArray(o.material) ? o.material : [o.material]
      const attributes = Object.fromEntries(
        Object.entries(o.geometry.attributes).map(([key, value]) => [
          key,
          {
            count: value.count,
            itemSize: value.itemSize,
            valuesHash: createHash('sha256')
              .update(
                JSON.stringify(
                  Array.from({ length: value.count }, (_, i) =>
                    Array.from({ length: value.itemSize }, (_, c) => value.getComponent(i, c)),
                  ),
                ),
              )
              .digest('hex'),
          },
        ]),
      )
      meshes.push({
        name: o.name,
        parent: o.parent?.name,
        matrix: o.matrix.toArray(),
        attributes,
        indicesHash: createHash('sha256')
          .update(JSON.stringify(Array.from(o.geometry.index?.array ?? [])))
          .digest('hex'),
        groups: o.geometry.groups,
        geometryBytes: geometryBytes(o.geometry),
        triangles: (o.geometry.index?.count ?? o.geometry.getAttribute('position').count) / 3,
        materials: materials.map((m) => ({
          name: m.name,
          side: m.side,
          color: m.color?.toArray(),
          metalness: m.metalness,
          roughness: m.roughness,
          normalScale: m.normalScale?.toArray(),
          maps: ['map', 'normalMap', 'metalnessMap', 'roughnessMap'].filter((slot) => m[slot]),
        })),
      })
    })
    return meshes
  }
  async function load(name, expected) {
    const bytes = await readFile(resolve(output, name))
    const sha = createHash('sha256').update(bytes).digest('hex')
    if (sha !== expected) throw new Error(`${name} hash drift`)
    const gltf = await loader.parseAsync(
      bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
      '',
    )
    if (gltf.animations.length) throw new Error('Unexpected animations: static pilot only.')
    const jsonLength = bytes.readUInt32LE(12)
    const json = JSON.parse(bytes.subarray(20, 20 + jsonLength).toString())
    const binStart = 20 + jsonLength + 8
    const images = (json.images ?? []).map((image) => {
      const view = json.bufferViews[image.bufferView]
      const data = bytes.subarray(
        binStart + (view.byteOffset ?? 0),
        binStart + (view.byteOffset ?? 0) + view.byteLength,
      )
      return {
        name: image.name,
        mimeType: image.mimeType,
        bytes: data.length,
        sha256: createHash('sha256').update(data).digest('hex'),
      }
    })
    const adapted = createPilotModel(gltf.scene, manifest.model)
    const result = {
      bytes: bytes.length,
      sha256: sha,
      images,
      sourceBoundsMeters: measuredBounds(gltf.scene),
      envelopeFeet: adapted.envelope,
      dimensionsFeet: adapted.dimensionsFeet,
      meshes: signature(gltf.scene),
    }
    adapted.release()
    gltf.scene.traverse((o) => {
      if (o instanceof Mesh) {
        o.geometry.dispose()
        for (const m of Array.isArray(o.material) ? o.material : [o.material]) m.dispose()
      }
    })
    return result
  }
  const source = await load('source.glb', manifest.model.sourceSha256)
  const optimized = await load('optimized.glb', manifest.model.optimizedSha256)
  if (
    JSON.stringify(source.meshes) !== JSON.stringify(optimized.meshes) ||
    JSON.stringify(source.images) !== JSON.stringify(optimized.images)
  )
    throw new Error(
      'Optimization changed attributes/material roles/images/hierarchy: review required.',
    )
  const report = {
    version: manifest.version,
    baseline: manifest.baseline,
    boundary:
      'CPU geometry/buffer/material-slot inspection. TextureLoader/GLTFLoader image pixels and canvas drawing stubbed; no render, visual, GPU, network timing or performance result.',
    procedural: {
      sku: 'bike',
      boundsFeet: measureParts(parts),
      parts: parts.length,
      materialBatches: batches.length,
      triangles: batches.reduce((n, b) => n + b.geometry.getAttribute('position').count / 3, 0),
      bakedGeometryBytes: batches.reduce((n, b) => n + geometryBytes(b.geometry), 0),
      standaloneModelTransferBytes: null,
      transferMeaning:
        'Procedural code shares the existing bundle; no honest isolated transfer equivalent.',
      sharedTextureMaps: baselineMaps,
      sharedTextureBytes: baselineMaps.reduce((n, t) => n + t.bytes, 0),
      generatedCanvasTextures: [
        ...new Set(
          batches.flatMap(({ material }) =>
            Object.values(material).filter((value) => value?.isCanvasTexture),
          ),
        ),
      ].map((texture) => ({
        width: texture.image.width,
        height: texture.image.height,
        note: 'Generated texture, no transfer file. Pixels intentionally not drawn in CPU runner.',
      })),
    },
    source,
    optimized,
    preservationPassed: true,
    comparison: {
      runtimeMs: null,
      gpuBytes: null,
      visualApproval: null,
      decision: manifest.model.decision,
    },
  }
  await writeFile(
    resolve(output, 'model-measurements.json'),
    JSON.stringify(report, null, 2) + '\n',
  )
  process.stdout.write(
    JSON.stringify(
      {
        procedural: report.procedural,
        sourceBytes: source.bytes,
        optimizedBytes: optimized.bytes,
        dimensionsFeet: optimized.dimensionsFeet,
        preservationPassed: true,
      },
      null,
      2,
    ) + '\n',
  )
} finally {
  releaseBatches()
  TextureLoader.prototype.loadAsync = originalLoad
  placeholders.forEach((t) => t.dispose())
  globalThis.document = previousDocument
  dom.window.close()
  await server.close()
}

import { readFileSync, readdirSync, realpathSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { z } from 'zod'
import { bytesDigest, digest } from './identity'
import { verifyPreparationAsset } from './assetValidation'
export { validatePreparationAssets, PREPARATION_ASSET_INVENTORY } from './assetValidation'

const root = new URL('../../../', import.meta.url)
// Explicit trusted closure; no caller paths, asset URLs or network requests.
const authoredSources = [
  'src/domain/design.ts',
  'src/domain/arrangements.ts',
  'src/domain/presentation.ts',
  'src/domain/designFixtures.ts',
  'src/lib/config.ts',
  'src/lib/products.ts',
  'src/lib/visuals.ts',
  'src/lib/recovery.ts',
  'src/lib/stillsManifest.ts',
  'src/render/unitParts.ts',
  'src/render/architecture.ts',
  'src/render/addons.ts',
  'src/render/equipment.ts',
  'src/render/geometry.ts',
  'src/render/parts.ts',
  'src/render/hash.ts',
  'src/render/palette.ts',
  'src/render/materials.ts',
  'src/render/envelope.ts',
  'src/render/openings.ts',
  'src/render/gallery.ts',
  'src/render/framing.ts',
  'src/render/scenery.ts',
  'src/components/StudioModel.tsx',
  'src/components/Mirror.tsx',
  'src/components/Equipment.tsx',
  'src/components/InteriorLights.tsx',
  'src/render/mirror.ts',
  'src/render/prototype/register.ts',
  'src/render/prototype/materialCapture.ts',
  'src/render/prototype/identity.ts',
  'src/render/prototype/provenance.ts',
  'src/render/prototype/prepare.ts',
  'src/render/prototype/fixtures.ts',
  'src/render/prototype/writeManifests.ts',
  'scripts/prototype-fixtures.ts',
  'package-lock.json',
  'public/textures/sources.json',
  'package.json',
  'src/components/Atmosphere.tsx',
  'src/components/Landscape.tsx',
  'src/components/Surroundings.tsx',
  'src/components/InteriorProbe.tsx',
  'src/components/Parts.tsx',
  'src/components/useInstances.ts',
  'render-server/requirements.txt',
  'render-server/requirements-construction.in',
  'render-server/requirements-construction.lock',
  'render-server/fury_render/blender.py',
  'render-server/fury_render/protocol.py',
  'render-server/fury_render/finishing.py',
  'render-server/fury_render/strict_construction.py',
  'scripts/build-textures.py',
] as const

function renderSources(directory: string): string[] {
  return readdirSync(new URL(`${directory}/`, root), { withFileTypes: true }).flatMap((entry) => {
    if (entry.isSymbolicLink()) throw new Error('Symlink in trusted source closure.')
    const path = `${directory}/${entry.name}`
    if (
      entry.name.startsWith('.') ||
      /\.(?:test|spec)\./.test(entry.name) ||
      entry.name === 'vitest.config.ts'
    )
      return []
    if (entry.isDirectory()) return renderSources(path)
    return /\.(?:tsx?|json|html)$/.test(entry.name) ? [path] : []
  })
}
const sourcePaths = [
  ...new Set([...authoredSources, ...renderSources('src/render'), ...renderSources('src/domain')]),
].sort()

function receipt(path: string) {
  try {
    const expected = join(fileURLToPath(root), path)
    if (realpathSync(new URL(path, root)) !== expected)
      throw new Error('Trusted source symlink rejected.')
    const bytes = readFileSync(new URL(path, root))
    return { path, status: 'present' as const, bytes: bytes.byteLength, digest: bytesDigest(bytes) }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    return { path, status: 'missing' as const, bytes: null, digest: null }
  }
}

const creditSchema = z.array(
  z.object({
    id: z.string(),
    source: z.string().optional(),
    name: z.string().optional(),
    authors: z.array(z.string()).optional(),
    sizeFt: z.array(z.number()).optional(),
  }),
)

export function sourceProvenance() {
  const sources = sourcePaths.map(receipt)
  if (sources.some((entry) => entry.status !== 'present'))
    throw new Error('Trusted preparation source is missing.')
  const toolchain = {
    node: process.versions.node,
    v8: process.versions.v8,
    platform: process.platform,
    arch: process.arch,
  }
  return {
    digest: digest({ sources, toolchain }),
    sources,
    toolchain,
    owner: 'unverified',
    rightsApproval: false as const,
  }
}

export function textureProvenance(sets: readonly string[]) {
  verifyPreparationAsset('public/textures/sources.json')
  const credits = creditSchema.parse(
    JSON.parse(readFileSync(new URL('public/textures/sources.json', root), 'utf8')),
  )
  return [...new Set(sets)].sort().map((set) => {
    // IDs originate from trusted authored material specs, but still forbid path traversal.
    if (!/^[a-z0-9_]+$/.test(set)) throw new Error('Invalid trusted texture-set ID.')
    const detailOnly = ['powder_coat', 'brushed_metal', 'knurling'].includes(set)
    const files = (detailOnly ? ['normal', 'arm'] : ['albedo', 'normal', 'arm']).map((channel) =>
      verifyPreparationAsset(`public/textures/${set}/${channel}.webp`),
    )
    const credit = credits.find((entry) => entry.id === set)
    return {
      set,
      files,
      creditedSource: credit?.source ?? null,
      creditedAuthors: credit?.authors ?? [],
      recordedTileSizeFt: credit?.sizeFt ?? null,
      owner: 'unverified',
      rightsApproval: false as const,
      calibration: 'recorded-source-scale-not-measured-or-approved' as const,
      pixelDecode: 'not-performed' as const,
    }
  })
}

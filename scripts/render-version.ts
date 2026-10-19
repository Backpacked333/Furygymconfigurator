import { createHash } from 'node:crypto'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

/**
 * The renderer's version (src/lib/stillKey.ts RENDER_VERSION): a short hash of every source that
 * changes what a path-traced still of a design looks like. A still baked by one version
 * (src/stills.manifest.json) is never shown by another, so a change to any of these files
 * retires the baked stills until `npm run bake` renders them again. Vite computes it when a build
 * or the dev server starts, and the dev server again when one of them changes (vite.config.ts).
 *
 * What counts:
 * - src/render/**, tests/private prototype aside: scene capture, cameras, tiers, exposure, scheduler.
 * - The scene's components: what is in the scene, and where.
 * - src/lib/visuals.ts (sky, sun, settings) and src/lib/config.ts with src/lib/products.ts (what
 *   a design is, and its geometry's dimensions).
 * - public/textures/**: the scanned materials themselves, and sources.json (which there are, and
 *   their scale). Images are hashed as they are, byte for byte.
 * - The render server's Blender scene, finishing (exposure, bloom, tone mapping, WebP) and wire
 *   format: render-server/fury_render/{blender,finishing,protocol}.py; and the Blender it runs:
 *   render-server/requirements.txt, and the lines of render-server/modal_app.py that pin Blender
 *   (bpy) and Python for the cloud's image.
 *
 * Everything else (the app shell, styles, the panel, tests) leaves the version alone. Line
 * endings of text files are normalized, so a Windows checkout gets the same version.
 */
export const RENDER_SOURCES = {
  /** Every file under these directories, tests aside. */
  directories: ['src/render', 'public/textures'],
  files: [
    'src/components/Scene.tsx',
    'src/components/StudioModel.tsx',
    'src/components/Landscape.tsx',
    'src/components/Surroundings.tsx',
    'src/components/Equipment.tsx',
    'src/components/InteriorLights.tsx',
    'src/components/InteriorProbe.tsx',
    'src/components/Mirror.tsx',
    'src/components/Atmosphere.tsx',
    'src/components/RenderEffects.tsx',
    // Shared geometry of the build, its settings and its lights, and plants' instances.
    'src/components/Parts.tsx',
    'src/components/useInstances.ts',
    'src/lib/visuals.ts',
    'src/lib/config.ts',
    'src/lib/products.ts',
    'render-server/fury_render/blender.py',
    'render-server/fury_render/finishing.py',
    'render-server/fury_render/protocol.py',
    'render-server/requirements.txt',
    'render-server/modal_app.py',
  ],
  /** Files of which only these lines count: the rest of the deploy script changes no pixel. */
  lines: { 'render-server/modal_app.py': /bpy==|python_version=/ } as Record<string, RegExp>,
}

/** Characters of the hash kept: plenty to tell versions apart, short enough for a path. */
export const VERSION_LENGTH = 10

const TEST = /\.test\.[cm]?[jt]sx?$/
/** Text, whose line endings are normalized; anything else is hashed byte for byte. */
const TEXT = /\.([cm]?[jt]sx?|json|py|txt|md|css|html)$/
// Private CPU preparation has its own source receipts; it never changes legacy v3 pixels.
const PRIVATE_PROTOTYPE = 'src/render/prototype/'
const RUNTIME_ONLY = new Set([
  'src/render/bench.ts',
  'src/render/traceStatus.ts',
  'src/render/stillStatus.ts',
])

type Sources = { directories: string[]; files: string[] }

/** Whether a file (relative to the root, with forward slashes) is a render source. */
export function isRenderSource(file: string, sources: Sources = RENDER_SOURCES) {
  if (RUNTIME_ONLY.has(file) || file.startsWith(PRIVATE_PROTOTYPE)) return false
  const name = file.slice(file.lastIndexOf('/') + 1)
  if (sources.files.includes(file)) return true
  if (TEST.test(name) || file.split('/').some((part) => part.startsWith('.'))) return false
  return sources.directories.some((dir) => file.startsWith(`${dir}/`))
}

/** The files that count, relative to `root` with forward slashes, in a fixed order. */
export function renderSources(root: string, sources: Sources = RENDER_SOURCES): string[] {
  const found: string[] = []
  const walk = (dir: string) => {
    for (const entry of readdirSync(join(root, dir), { withFileTypes: true })) {
      if (entry.name.startsWith('.')) continue
      const path = `${dir}/${entry.name}`
      if (`${path}/`.startsWith(PRIVATE_PROTOTYPE)) continue
      if (entry.isDirectory()) walk(path)
      else if (entry.isFile() && isRenderSource(path, sources)) found.push(path)
    }
  }
  for (const dir of sources.directories) walk(dir)
  return [
    ...new Set([...found, ...sources.files.filter((file) => isRenderSource(file, sources))]),
  ].sort()
}

/** The version of the sources under `root`: the same files with the same contents, the same hash. */
export function renderVersion(
  root: string,
  files = renderSources(root),
  sources: Pick<typeof RENDER_SOURCES, 'lines'> = RENDER_SOURCES,
): string {
  const hash = createHash('sha256')
  for (const file of [...files].sort()) {
    let bytes: Buffer
    try {
      bytes = readFileSync(join(root, file))
    } catch (error) {
      throw new Error(
        `The render version reads ${file}, which is missing: update RENDER_SOURCES in scripts/render-version.ts.`,
        { cause: error },
      )
    }
    const lines = sources.lines[file]
    let content: string | Buffer = bytes
    if (TEXT.test(file)) {
      const text = bytes.toString('utf8').replace(/\r\n/g, '\n')
      content = lines
        ? text
            .split('\n')
            .filter((line) => lines.test(line))
            .join('\n')
        : text
    }
    // Each file's path is hashed with its contents, so a rename is a new version too.
    hash.update(`${file}\0`)
    hash.update(content)
    hash.update('\0')
  }
  return hash.digest('hex').slice(0, VERSION_LENGTH)
}

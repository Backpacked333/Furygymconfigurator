import process from 'node:process'
import { readFile, readdir } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { fileURLToPath, URL } from 'node:url'
import { relative, resolve } from 'node:path'
import { createServer } from 'vite'

// node src/dev/visual/export-fixtures.mjs > /path/outside/repo/fixtures.json
const root = fileURLToPath(new URL('../../../', import.meta.url))
const server = await createServer({
  root,
  configFile: false,
  optimizeDeps: { noDiscovery: true, include: [] },
  server: { middlewareMode: true },
  appType: 'custom',
})
try {
  const fixtures = await server.ssrLoadModule('/src/dev/visual/fixtures.ts')
  const coverage = await server.ssrLoadModule('/src/dev/visual/coverage.ts')
  const { fixtureValidity } = await server.ssrLoadModule('/src/dev/visual/viewerModel.ts')
  const { NEUTRAL_STAGE, MATERIAL_ROLES } = await server.ssrLoadModule(
    '/src/dev/visual/neutralStage.ts',
  )
  const { cylinder } = await server.ssrLoadModule('/src/render/geometry.ts')
  const { auditCylinderUV } = await server.ssrLoadModule('/src/dev/visual/uvAudit.ts')
  const assets = []
  async function scan(directory) {
    for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) =>
      a.name.localeCompare(b.name, 'en'),
    )) {
      const path = resolve(directory, entry.name)
      if (entry.isDirectory()) await scan(path)
      else if (entry.isFile()) {
        const bytes = await readFile(path)
        assets.push({
          path: relative(root, path),
          bytes: bytes.length,
          sha256: createHash('sha256').update(bytes).digest('hex'),
        })
      }
    }
  }
  await scan(resolve(root, 'public/textures'))
  const recipes = await Promise.all(
    fixtures.VISUAL_FIXTURES.flatMap((fixture) =>
      fixture.shots.map(async (shot) => ({
        ...fixtures.resolveFixture(fixture.id, shot.id),
        recipeHash: await fixtures.fixtureHash(fixture.id, shot.id),
      })),
    ),
  )
  process.stdout.write(
    JSON.stringify(
      {
        version: fixtures.FIXTURE_VERSION,
        baseRevision: fixtures.BASE_REVISION,
        assetRevision: fixtures.ASSET_REVISION,
        validity: fixtureValidity(),
        evidence:
          'Recipes and CPU diagnostics only; no rendered, licensed-pilot, physical-GPU or human-approval evidence.',
        fixtures: fixtures.VISUAL_FIXTURES,
        captureProfiles: fixtures.CAPTURE_PROFILES,
        recipes,
        coverage: coverage.COVERAGE_LEDGER,
        productFacts: coverage.PRODUCT_FACTS,
        rubric: coverage.VISUAL_RUBRIC,
        neutralStage: NEUTRAL_STAGE,
        materialRoles: MATERIAL_ROLES,
        assets,
        cylinderProbe: {
          input: { radiusFeet: 1, heightFeet: 2, segments: 32 },
          ...auditCylinderUV(cylinder(1, 1, 2, 32)),
        },
      },
      null,
      2,
    ) + '\n',
  )
} finally {
  await server.close()
}

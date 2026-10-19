// Real config-free in-memory build only: no browser, image, remote fetch, app plugin or capture attempt.
import { expect, it } from 'vitest'
import { fileURLToPath } from 'node:url'
import { BUILD_PATH, PAGE_PATH, SOURCE_ROOT, manifestDigest, prepareCaptureBuild } from './host'
import { HISTORY_DIRECTORY } from './runner'
import { TEXTURE_SETS } from '../../materials'

it('builds a fully hashed private closure matching the browser bootstrap and worker URLs', async () => {
  const prepared = await prepareCaptureBuild(() => {})
  expect(PAGE_PATH).toBe('/worker.html?renderer=webgl2')
  expect(prepared.resources.has('/worker.html')).toBe(true)
  expect(JSON.parse(prepared.resources.get(BUILD_PATH)!.bytes.toString())).toEqual(prepared.build)
  expect(prepared.build.sourceManifestDigest).toBe(manifestDigest(prepared.manifests.sources))
  expect(prepared.build.assetManifestDigest).toBe(manifestDigest(prepared.manifests.assets))
  expect(prepared.build.bundleDigest).toBe(manifestDigest(prepared.manifests.bundle))
  expect(
    prepared.manifests.sources.some(
      ({ name }) => name === 'src/render/prototype/capture/browser/scene.tsx',
    ),
  ).toBe(true)
  expect(
    prepared.manifests.sources.some(({ name }) => name === 'src/render/siteLight.worker.ts'),
  ).toBe(true)
  expect(
    prepared.manifests.sources.some(
      ({ name }) => name === 'node_modules/three/build/three.webgpu.js',
    ),
  ).toBe(true)
  expect(
    prepared.manifests.bundle.filter(({ name }) =>
      /^assets\/siteLight\.worker-[A-Za-z0-9_-]+\.js$/.test(name),
    ),
  ).toHaveLength(1)
  expect(prepared.manifests.assets.map(({ name }) => name).sort()).toEqual(
    Object.entries(TEXTURE_SETS)
      .flatMap(([set, value]) =>
        ('detailOnly' in value ? ['normal', 'arm'] : ['albedo', 'normal', 'arm']).map(
          (channel) => `public/textures/${set}/${channel}.webp`,
        ),
      )
      .sort(),
  )
  expect(
    prepared.manifests.sources.some(({ name }) => name === 'src/domain/localRenderSlice.ts'),
  ).toBe(true)
  expect(SOURCE_ROOT).toBe(
    fileURLToPath(new URL('../../../../', import.meta.url)).replace(/\/$/, ''),
  )
  expect(HISTORY_DIRECTORY).toBe(
    '/home/ubuntu/Documents/fury-capture-handoff/local-three-capture-history',
  )
  await prepared.revalidate()
  const again = await prepareCaptureBuild(() => {})
  expect(again.build).toEqual(prepared.build)
  const page = prepared.resources.get('/worker.html')!.bytes
  page[0] ^= 1
  await expect(prepared.revalidate()).rejects.toMatchObject({ code: 'identity-mismatch' })
}, 120_000)

// Real disposable loopback HTTP only. No app/browser/rendering, remote requests or downloaded tooling.
import { request } from 'node:http'
import { mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it } from 'vitest'
import {
  BUILD_PATH,
  PAGE_PATH,
  SOURCE_ROOT,
  assertOutsideSource,
  assertBrowserModule,
  manifestDigest,
  readTrustedFile,
  startCaptureHost,
  type CaptureHost,
} from './host'
import { digest } from './artifacts'
const owned: string[] = [],
  hosts: CaptureHost[] = []
afterEach(async () => {
  await Promise.all(hosts.splice(0).map((host) => host.close()))
  await Promise.all(owned.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})
async function start() {
  const bytes = Buffer.from('SYNTHETIC TEST ONLY'),
    resources = new Map([
      [PAGE_PATH.split('?')[0], { bytes, mediaType: 'text/html' }],
      [BUILD_PATH, { bytes: Buffer.from('{}'), mediaType: 'application/json' }],
      ['/assets/test.js', { bytes: Buffer.from('/* test only */'), mediaType: 'text/javascript' }],
    ])
  const host = await startCaptureHost(resources, () => {})
  hosts.push(host)
  return { host, bytes, resources }
}
function get(host: CaptureHost, path: string, headers = {}, method = 'GET') {
  return new Promise<{ status: number; headers: Record<string, unknown>; body: Buffer }>(
    (resolve, reject) => {
      const req = request(`${host.origin}/`, { path, method, headers }, (res) => {
        const chunks: Buffer[] = []
        res.on('data', (chunk: Buffer) => chunks.push(chunk))
        res.on('end', () =>
          resolve({ status: res.statusCode!, headers: res.headers, body: Buffer.concat(chunks) }),
        )
      })
      req.once('error', reject)
      req.end()
    },
  )
}
describe('private immutable loopback allowlist', () => {
  it('serves exact pre-read bytes with restrictive CSP and no CORS/API', async () => {
    const { host, bytes, resources } = await start()
    bytes.fill(0)
    resources.clear()
    const reply = await get(host, PAGE_PATH)
    expect(reply.status).toBe(200)
    expect(reply.body.toString()).toBe('SYNTHETIC TEST ONLY')
    expect(reply.headers['access-control-allow-origin']).toBeUndefined()
    expect(reply.headers['content-security-policy']).toContain("worker-src 'self'")
    expect(reply.headers['content-security-policy']).not.toContain('unsafe-eval')
    expect(host.stats()).toEqual({ requests: 1, bytes: 19, denied: 0 })
  })
  it.each([
    '/../../package.json',
    '/%2e%2e/package.json',
    '/assets/test.js?x=1',
    '/assets/test.js#x',
    '/assets\\test.js',
    '/api/jobs',
    '/textures/unknown.webp',
    '/__capture_bootstrap.json?url=https://example.invalid',
  ])('denies unknown/ambiguous %s and poisons the job', async (path) => {
    const { host } = await start()
    expect((await get(host, path)).status).toBe(403)
    expect(() => host.assertHealthy()).toThrow()
  })
  it.each([
    { host: 'localhost' },
    { origin: 'https://example.invalid' },
    { 'x-forwarded-host': '127.0.0.1' },
    { forwarded: 'for=127.0.0.1' },
  ])('rejects host/origin/forwarding %j', async (headers) => {
    const { host } = await start()
    expect((await get(host, BUILD_PATH, headers)).status).toBe(403)
  })
  it('rejects duplicate sensitive headers and cross-site fetch metadata', async () => {
    const { host } = await start()
    expect((await get(host, BUILD_PATH, { origin: [host.origin, host.origin] })).status).toBe(403)
    expect((await get(host, BUILD_PATH, { 'sec-fetch-site': 'cross-site' })).status).toBe(403)
  })
  it('denies external, blob, file, websocket, redirects and non-GET before network', async () => {
    const { host } = await start()
    for (const url of [
      'https://example.invalid/asset',
      'file:///tmp/private',
      'blob:test',
      `ws://${host.origin.slice(7)}/assets/test.js`,
      `${host.origin}.evil/assets/test.js`,
    ])
      expect(host.allow(url, 'GET')).toBe(false)
    expect(host.allow(`${host.origin}${BUILD_PATH}`, 'GET', true)).toBe(false)
    expect(host.allow(`${host.origin}${BUILD_PATH}`, 'POST')).toBe(false)
    expect((await get(host, BUILD_PATH, {}, 'POST')).status).toBe(403)
  })
})
describe('trusted source closure', () => {
  it.each([
    'fury-real',
    'fury-real-handoff',
    'fury-next',
    'fury-ui',
    'fury-capture',
    'fury-capture-handoff',
  ])('protects other source/ledger roots: %s', (name) => {
    expect(() => assertOutsideSource(join(dirname(SOURCE_ROOT), name, 'new-output'))).toThrow()
  })
  it('protects the current source tree independently of checkout location', () => {
    expect(() => assertOutsideSource(join(SOURCE_ROOT, 'new-output'))).toThrow()
  })
  it.each([
    'src/App.tsx',
    'src/legacyEntry.tsx',
    'src/components/Scene.tsx',
    'src/components/RenderEffects.tsx',
    'src/render/cloud.ts',
    'src/render/pathtrace.ts',
    'src/render/stills.ts',
    'src/render/prefetch.ts',
    'src/render/prototype/register.ts',
    'src/render/prototype/prepare.ts',
    'src/render/prototype/materialCapture.ts',
    'src/render/prototype/capture/runner.ts',
    'src/image-service/protocol.ts',
    'src/prototype/ImageConfigurator.tsx',
    'node_modules/oidn-web/index.js',
  ])('rejects forbidden graph module %s', (name) =>
    expect(() => assertBrowserModule(name)).toThrow(),
  )
  it.each([
    'src/components/StudioModel.tsx',
    'src/components/Atmosphere.tsx',
    'src/components/Landscape.tsx',
    'src/render/materials.ts',
    'src/render/scanFiles.ts',
    'src/render/siteLight.worker.ts',
    'src/render/prototype/capture/browser/worker.ts',
    'src/render/prototype/capture/browser/scene.tsx',
    'src/render/prototype/capture/browser/entry.ts',
    'src/domain/design.ts',
    'node_modules/three/build/three.webgpu.js',
  ])('allows trusted graph module %s', (name) =>
    expect(() => assertBrowserModule(name)).not.toThrow(),
  )
  it('rejects symlink escapes and oversized trusted reads', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'fury-host-test-'))
    owned.push(dir)
    await writeFile(join(dir, 'one.txt'), 'trusted fixture')
    await symlink(join(dir, 'one.txt'), join(dir, 'link.txt'))
    expect((await readTrustedFile(join(dir, 'one.txt'), dir)).toString()).toBe('trusted fixture')
    await expect(readTrustedFile(join(dir, 'link.txt'), dir)).rejects.toThrow()
    await expect(readTrustedFile(join(dir, 'one.txt'), dir, 2)).rejects.toThrow()
  })
  it('binds canonical named bytes independent of manifest iteration order', () => {
    const a = { name: 'a.ts', bytes: 1, digest: digest('a') },
      b = { name: 'b.ts', bytes: 1, digest: digest('b') }
    expect(manifestDigest([a, b])).toBe(manifestDigest([b, a]))
    expect(manifestDigest([a, b])).not.toBe(manifestDigest([a, { ...b, digest: digest('c') }]))
  })
})

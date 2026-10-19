// @vitest-environment node
import { EventEmitter } from 'node:events'
import { existsSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ViteDevServer } from 'vite'
import { defaultDesign } from '../src/domain/design'
import { createImageRequest } from '../src/image-service/protocol'
import { invokeMockHttp } from '../src/image-service/httpTestHarness'
import type { MockImageMiddleware } from '../src/image-service/http'
import { prototypeImagePlugin } from './prototype-image-plugin'

const cleanups: (() => void)[] = []
function serverFixture(production = false, command = 'serve', mode = 'development') {
  const directory = mkdtempSync(join(tmpdir(), 'fury-mock-plugin-'))
  const middlewares: MockImageMiddleware[] = []
  const events = new EventEmitter()
  const server = {
    config: {
      root: process.cwd(),
      command,
      mode,
      isProduction: production,
      logger: { info: vi.fn(), warn: vi.fn() },
    },
    middlewares: { use: (middleware: MockImageMiddleware) => middlewares.push(middleware) },
    httpServer: events,
  } as unknown as ViteDevServer
  cleanups.push(() => {
    events.emit('close')
    rmSync(directory, { recursive: true, force: true })
  })
  return { directory, middlewares, server, events }
}
async function configure(server: ViteDevServer, directory: string) {
  const plugin = prototypeImagePlugin({ stateDirectory: directory })
  const hook = plugin.configureServer
  if (typeof hook !== 'function') throw new Error('Missing serve hook')
  await hook.call({} as never, server)
  return plugin
}
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup()
  vi.unstubAllEnvs()
  vi.useRealTimers()
})

describe('Vite plugin mounting guards (no Vite server started)', () => {
  it('is serve-only and disabled by default', async () => {
    vi.stubEnv('FURY_IMAGE_PROTOTYPE', '')
    const f = serverFixture()
    const plugin = await configure(f.server, f.directory)
    expect(plugin.apply).toBe('serve')
    expect(f.middlewares).toHaveLength(0)
  })

  it.each(['production-config', 'production-env', 'production-mode', 'build-command'])(
    'never mounts for %s even with opt-in',
    async (mode) => {
      vi.stubEnv('FURY_IMAGE_PROTOTYPE', '1')
      vi.stubEnv('NODE_ENV', mode === 'production-env' ? 'production' : 'development')
      const f = serverFixture(
        mode === 'production-config',
        mode === 'build-command' ? 'build' : 'serve',
        mode === 'production-mode' ? 'production' : 'development',
      )
      await configure(f.server, f.directory)
      expect(f.middlewares).toHaveLength(0)
    },
  )

  it('mounts only the mock route on explicit dev opt-in and closes admission with server lifecycle', async () => {
    vi.stubEnv('FURY_IMAGE_PROTOTYPE', '1')
    vi.stubEnv('NODE_ENV', 'development')
    const f = serverFixture()
    await configure(f.server, f.directory)
    expect(f.middlewares).toHaveLength(1)
    expect(
      (await invokeMockHttp(f.middlewares[0], { body: createImageRequest(defaultDesign()) }).result)
        .status,
    ).toBe(202)
    f.events.emit('close')
    expect(
      (await invokeMockHttp(f.middlewares[0], { body: createImageRequest(defaultDesign()) }).result)
        .status,
    ).toBe(503)
  })

  it('observes the out-of-band STOP file and persists the kill latch after restart', async () => {
    vi.stubEnv('FURY_IMAGE_PROTOTYPE', '1')
    vi.stubEnv('NODE_ENV', 'development')
    const f = serverFixture()
    await configure(f.server, f.directory)
    writeFileSync(join(f.directory, 'STOP'), 'operator stopped local mock\n')
    expect(
      (await invokeMockHttp(f.middlewares[0], { body: createImageRequest(defaultDesign()) }).result)
        .status,
    ).toBe(503)
    f.events.emit('close')
    rmSync(join(f.directory, 'STOP'))
    await configure(f.server, f.directory)
    expect(
      (await invokeMockHttp(f.middlewares[1], { body: createImageRequest(defaultDesign()) }).result)
        .status,
    ).toBe(503)
  })

  it('fails closed for unavailable store paths instead of falling back to memory or a renderer', async () => {
    vi.stubEnv('FURY_IMAGE_PROTOTYPE', '1')
    vi.stubEnv('NODE_ENV', 'development')
    const f = serverFixture()
    const file = join(f.directory, 'not-a-directory')
    writeFileSync(file, 'test-owned sentinel')
    await configure(f.server, file)
    expect(f.middlewares).toHaveLength(1)
    expect(
      (await invokeMockHttp(f.middlewares[0], { body: createImageRequest(defaultDesign()) }).result)
        .body,
    ).toMatchObject({ error: { code: 'unavailable' } })
  })

  it('rejects symlinked state paths back into tracked source before creating any file', async () => {
    vi.stubEnv('FURY_IMAGE_PROTOTYPE', '1')
    vi.stubEnv('NODE_ENV', 'development')
    const f = serverFixture()
    const alias = join(f.directory, 'source-alias')
    symlinkSync(process.cwd(), alias)
    await configure(f.server, join(alias, '__must-not-create-prototype-state'))
    expect(existsSync(join(process.cwd(), '__must-not-create-prototype-state'))).toBe(false)
    expect(
      (await invokeMockHttp(f.middlewares[0], { body: createImageRequest(defaultDesign()) }).result)
        .status,
    ).toBe(503)
  })

  it('rejects state paths inside tracked source', async () => {
    vi.stubEnv('FURY_IMAGE_PROTOTYPE', '1')
    vi.stubEnv('NODE_ENV', 'development')
    const f = serverFixture()
    await configure(f.server, join(process.cwd(), '__must-not-create-prototype-state'))
    expect(existsSync(join(process.cwd(), '__must-not-create-prototype-state'))).toBe(false)
    expect(
      (await invokeMockHttp(f.middlewares[0], { body: createImageRequest(defaultDesign()) }).result)
        .status,
    ).toBe(503)
  })
})

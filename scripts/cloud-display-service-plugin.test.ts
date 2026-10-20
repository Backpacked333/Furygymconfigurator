import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ViteDevServer } from 'vite'
import { cloudDisplayServicePlugin } from './cloud-display-service-plugin'

function server() {
  return {
    config: {
      root: '/inert/source',
      command: 'serve',
      mode: 'development',
      isProduction: false,
      logger: { warn: vi.fn() },
    },
    middlewares: { use: vi.fn() },
    httpServer: { once: vi.fn() },
  } as unknown as ViteDevServer
}
afterEach(() => vi.unstubAllEnvs())
describe('private cloud DEV plugin: no provider imports during disabled mode', () => {
  it('does not invoke the production factory in disabled or production contexts', async () => {
    vi.stubEnv('FURY_IMAGE_PROTOTYPE', '0')
    const factory = vi.fn(),
      plugin = cloudDisplayServicePlugin(factory),
      fake = server()
    await (plugin.configureServer as (server: ViteDevServer) => Promise<void>)(fake)
    expect(factory).not.toHaveBeenCalled()
    expect(fake.middlewares.use).toHaveBeenCalledOnce()
    const apply = plugin.apply as (
      config: object,
      env: { command: string; mode: string; isPreview?: boolean },
    ) => boolean
    expect(apply({}, { command: 'build', mode: 'development' })).toBe(false)
    expect(apply({}, { command: 'serve', mode: 'production' })).toBe(false)
    expect(apply({}, { command: 'serve', mode: 'development', isPreview: true })).toBe(false)
  })
  it('uses injected inert connection only in DEV and keeps setup failures bounded/unconfigured', async () => {
    vi.stubEnv('FURY_IMAGE_PROTOTYPE', '1')
    vi.stubEnv('NODE_ENV', 'test')
    const close = vi.fn(async () => {}),
      service = { submit: vi.fn(), status: vi.fn(), cancel: vi.fn(), image: vi.fn(), close }
    const factory = vi.fn(async () => ({ service, authenticate: () => null }))
    const plugin = cloudDisplayServicePlugin(factory),
      fake = server()
    await (plugin.configureServer as (server: ViteDevServer) => Promise<void>)(fake)
    expect(factory).toHaveBeenCalledWith('/inert/source')
    expect(fake.middlewares.use).toHaveBeenCalledOnce()
    await (plugin.closeBundle as () => Promise<void>)()
    expect(close).toHaveBeenCalledOnce()
    const broken = cloudDisplayServicePlugin(async () => {
        throw new Error('DO NOT REFLECT PRIVATE DETAILS')
      }),
      other = server()
    await (broken.configureServer as (server: ViteDevServer) => Promise<void>)(other)
    expect(other.middlewares.use).toHaveBeenCalledOnce()
    expect(other.config.logger.warn).not.toHaveBeenCalledWith(
      expect.stringContaining('PRIVATE DETAILS'),
    )
  })
})

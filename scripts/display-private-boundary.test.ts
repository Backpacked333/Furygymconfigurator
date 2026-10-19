import { describe, expect, it } from 'vitest'
import { displayPrivateBoundary, isPrivateDisplayPath } from './display-private-boundary'
import { parseDisplayOperatorArgs } from './display-operator'

describe('display private module boundary independent of DEV service flags', () => {
  it.each([
    '/src/render/display/browser/entry.ts',
    '/src//render/display/browser/entry.ts?raw',
    '/src/render/ignored/../display/browser/entry.ts',
    '/@fs/home/ubuntu/Documents/fury-display/src/render/display/backend.ts',
    '/%73rc%2frender%2fdisplay%2fbrowser%2fentry.ts',
    '/%2573rc%252frender%252fdisplay%252fbrowser%252fentry.ts',
    '/src\\render\\display\\browser\\entry.ts',
    '/src/display/operator.ts',
    '/src/display/readiness.ts',
    '/src/display/session.ts',
    '/src/image-service/display/service.ts',
    '/scripts/display-operator.ts',
    '/src/image-service/remote-display/worker/backend.ts',
    '/src/image-service/remote-display/service/service.ts?raw',
    '/@fs/home/ubuntu/Documents/fury-display-cloud/src/display/cloudSession.ts',
    '/%2573rc%252fimage-service%252fremote-display%252fworker%252fbackend.ts',
    '/src/image-service/ignored/../remote-display/service/auth.ts',
    '/scripts/cloud-display-service-plugin.ts',
    '/scripts/cloud-display-worker-verify.ts',
  ])('denies private Vite source URL %s', (path) => expect(isPrivateDisplayPath(path)).toBe(true))
  it.each([
    '/src/display/contract.ts',
    '/src/display/cloudContract.ts',
    '/src/prototype/cloudDisplayClient.ts',
    '/src/prototype/displayClient.ts',
    '/src/components/Atmosphere.tsx',
    '/assets/vendor.js',
  ])('preserves public path %s', (path) => expect(isPrivateDisplayPath(path)).toBe(false))
  it('installs source guard for all serve/preview modes, not a renderer import', () => {
    const plugin = displayPrivateBoundary()
    expect(plugin.apply).toBeUndefined()
    expect(plugin.configureServer).toBeTypeOf('function')
    expect(plugin.configurePreviewServer).toBeTypeOf('function')
    expect(plugin.generateBundle).toBeTypeOf('function')
  })
  it('rejects rendered remote modules and execution symbols from customer bundles', () => {
    const generate = displayPrivateBoundary().generateBundle as (
      options: unknown,
      bundle: Record<string, unknown>,
    ) => void
    for (const name of [
      '/candidate/src/image-service/remote-display/service/service.ts',
      '/candidate/src/image-service/remote-display/worker/backend.ts',
      '/candidate/src/display/cloudSession.ts',
      '/candidate/scripts/cloud-display-service-plugin.ts',
    ])
      expect(() =>
        generate(
          {},
          { output: { type: 'chunk', code: '', modules: { [name]: { renderedLength: 1 } } } },
        ),
      ).toThrow('Private display module')
    expect(() =>
      generate(
        {},
        { output: { type: 'chunk', code: 'createRemoteDisplayBackend()', modules: {} } },
      ),
    ).toThrow('Private display execution')
    expect(() =>
      generate(
        {},
        {
          output: {
            type: 'chunk',
            code: '',
            modules: { '/candidate/src/display/cloudContract.ts': { renderedLength: 1 } },
          },
        },
      ),
    ).not.toThrow()
  })
  it('preview intercepts encoded cloud endpoints without installing a service', () => {
    type Middleware = (
      request: { url: string },
      response: { statusCode: number; end(): void },
      next: () => void,
    ) => void
    let middleware!: Middleware
    const configure = displayPrivateBoundary().configurePreviewServer as unknown as (server: {
      middlewares: { use(value: Middleware): void }
    }) => void
    configure({
      middlewares: {
        use(value) {
          middleware = value
        },
      },
    })
    for (const url of [
      '/__fury-display-cloud/v1/images',
      '/%255f%255ffury-display-cloud/v1/images',
    ]) {
      let ended = false,
        next = false
      const response = {
        statusCode: 200,
        end() {
          ended = true
        },
      }
      middleware({ url }, response, () => {
        next = true
      })
      expect(response.statusCode).toBe(404)
      expect(ended).toBe(true)
      expect(next).toBe(false)
    }
  })
  it('requires explicit operator mode and never exposes permit/reset/executable/provider flags', () => {
    expect(parseDisplayOperatorArgs(['--preflight'])).toBe('--preflight')
    expect(parseDisplayOperatorArgs(['--serve'])).toBe('--serve')
    for (const args of [
      [],
      ['--render'],
      ['--permit'],
      ['--reset'],
      ['--serve', '--force'],
      ['--provider', 'modal'],
    ])
      expect(() => parseDisplayOperatorArgs(args)).toThrow()
  })
})

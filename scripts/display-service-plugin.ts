import type { Plugin } from 'vite'
import {
  createDisplayMiddleware,
  type DisplayAuthenticator,
  type DisplayHttpService,
} from '../src/image-service/display/http'

export type DisplayServicePluginFactory = (root: string) => Promise<{
  service: DisplayHttpService & { close(): Promise<void> }
  authenticate: DisplayAuthenticator
}>
const productionFactory: DisplayServicePluginFactory = async (root) => {
  const { createProductionDisplayService } = await import('../src/image-service/display/production')
  return createProductionDisplayService(root)
}

/** Explicit DEV connection flags are NOT execution permission. Never imported by build/preview. */
export function displayServicePlugin(
  factory: DisplayServicePluginFactory = productionFactory,
): Plugin {
  let close = async () => {}
  return {
    name: 'fury-private-display-candidate',
    apply: (_config, environment) =>
      environment.command === 'serve' &&
      !environment.isPreview &&
      environment.mode !== 'production' &&
      process.env.NODE_ENV !== 'production',
    async configureServer(server) {
      // Private source is not an app-dev-server entry, even when someone guesses a Vite /@fs URL.
      server.middlewares.use((request, response, next) => {
        let path = request.url ?? ''
        try {
          for (let n = 0; n < 3; n++) path = decodeURIComponent(path)
          path = new URL(path.replaceAll('\\', '/'), 'http://localhost').pathname
        } catch {
          response.statusCode = 404
          response.end()
          return
        }
        if (
          /\/(?:src\/(?:render\/display|image-service\/display)(?:\/|$)|src\/display\/(?:session|readiness)(?:\.|$)|scripts\/display-(?:service|renderer))/.test(
            path,
          )
        ) {
          response.statusCode = 404
          response.setHeader('Cache-Control', 'private, no-store')
          response.end()
          return
        }
        next()
      })
      const enabled =
        process.env.FURY_IMAGE_PROTOTYPE === '1' &&
        process.env.FURY_PRIVATE_DISPLAY === '1' &&
        process.env.NODE_ENV !== 'production' &&
        server.config.command === 'serve' &&
        server.config.mode !== 'production' &&
        !server.config.isProduction
      if (!enabled) {
        server.middlewares.use(createDisplayMiddleware())
        return
      }
      try {
        const connection = await factory(server.config.root)
        close = () => connection.service.close()
        server.middlewares.use(createDisplayMiddleware(connection))
        server.httpServer?.once('close', () => {
          void close().catch(() => {
            server.config.logger.warn(
              'Private display teardown unconfirmed; no replacement is admitted.',
            )
          })
        })
        server.config.logger.info(
          'Private display candidate connection enabled, not rendering permission: operator permit/owner credential and hardware GPU remain required; quality and latency untested.',
        )
      } catch {
        server.middlewares.use(createDisplayMiddleware())
        server.config.logger.warn(
          'Private display unavailable; no renderer, permit, fallback or paid dispatch was started.',
        )
      }
    },
    async closeBundle() {
      await close()
    },
  }
}

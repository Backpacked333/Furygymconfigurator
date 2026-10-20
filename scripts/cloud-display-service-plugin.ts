import type { Plugin } from 'vite'
import {
  createCloudDisplayMiddleware,
  type CloudAuthenticator,
  type CloudHttpService,
} from '../src/image-service/remote-display/service/http'

export type CloudDisplayServicePluginFactory = (root: string) => Promise<{
  service: CloudHttpService & { close(): Promise<void> }
  authenticate?: CloudAuthenticator
}>
const productionFactory: CloudDisplayServicePluginFactory = async () => {
  // Only this private service boundary imports the real candidate backend; no P04/local adapter.
  const { createRemoteDisplayBackend } =
    await import('../src/image-service/remote-display/worker/backend')
  const { createCloudDisplayService } =
    await import('../src/image-service/remote-display/service/service')
  // Intentionally no owner, directory, evidence observer or approval provisioning in this build.
  return { service: createCloudDisplayService({ backend: createRemoteDisplayBackend() }) }
}
/** Register BEFORE displayServicePlugin: its legacy matcher also catches this namespace.
 * DEV connection is not paid execution authorization. No env switch can admit cloud dispatch. */
export function cloudDisplayServicePlugin(
  factory: CloudDisplayServicePluginFactory = productionFactory,
): Plugin {
  let close = async () => {}
  return {
    name: 'fury-private-cloud-display-candidate',
    apply: (_config, environment) =>
      environment.command === 'serve' &&
      !environment.isPreview &&
      environment.mode !== 'production' &&
      process.env.NODE_ENV !== 'production',
    async configureServer(server) {
      if (
        server.config.command !== 'serve' ||
        server.config.isProduction ||
        server.config.mode === 'production' ||
        process.env.NODE_ENV === 'production' ||
        process.env.FURY_IMAGE_PROTOTYPE !== '1'
      ) {
        server.middlewares.use(createCloudDisplayMiddleware())
        return
      }
      try {
        const connection = await factory(server.config.root)
        close = () => connection.service.close()
        server.middlewares.use(createCloudDisplayMiddleware(connection))
        server.httpServer?.once('close', () => {
          void close().catch(() =>
            server.config.logger.warn(
              'Cloud display teardown remains unconfirmed; replacement is denied.',
            ),
          )
        })
      } catch {
        server.middlewares.use(createCloudDisplayMiddleware())
        server.config.logger.warn(
          'Cloud display is unavailable; no worker or provider was dispatched.',
        )
      }
    },
    async closeBundle() {
      await close()
    },
  }
}

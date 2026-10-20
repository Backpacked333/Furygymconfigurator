import type { Plugin } from 'vite'
import {
  createLocalRenderMiddleware,
  type LocalRenderHttpService,
} from '../src/image-service/localRenderHttp'

export type LocalRenderPluginFactory = (
  root: string,
) => Promise<LocalRenderHttpService & { close(): void }>
const defaultFactory: LocalRenderPluginFactory = async (root) => {
  // No private capture, Three, or history import until the operator explicitly enables this DEV service.
  const [{ LocalRenderService }, { createLocalRenderBackend }] = await Promise.all([
    import('../src/image-service/localRenderService'),
    import('../src/image-service/localRenderPrivate'),
  ])
  return new LocalRenderService(createLocalRenderBackend(root))
}

/** Only mounted by Vite's nonpreview DEV serve branch. Disabled real URLs never fall into mock v1. */
export function localRenderPlugin(factory: LocalRenderPluginFactory = defaultFactory): Plugin {
  let close = () => {}
  return {
    name: 'fury-local-real-render-images',
    apply: (_config, environment) =>
      environment.command === 'serve' &&
      !environment.isPreview &&
      environment.mode !== 'production',
    async configureServer(server) {
      const enabled =
        process.env.FURY_IMAGE_PROTOTYPE === '1' &&
        process.env.FURY_LOCAL_REAL_IMAGES === '1' &&
        process.env.NODE_ENV !== 'production' &&
        server.config.command === 'serve' &&
        server.config.mode !== 'production' &&
        !server.config.isProduction
      if (!enabled) {
        server.middlewares.use(createLocalRenderMiddleware())
        return
      }
      try {
        const service = await factory(server.config.root)
        close = () => service.close()
        server.middlewares.use(createLocalRenderMiddleware({ service }))
        server.httpServer?.once('close', close)
        server.config.logger.info(
          'Local real preview enabled: unqualified software only; retained capture history and all review holds remain in force.',
        )
      } catch {
        server.middlewares.use(createLocalRenderMiddleware())
        server.config.logger.warn(
          'Local real preview unavailable; no mock, historical image, paid fallback or fresh capture budget was enabled.',
        )
      }
    },
    closeBundle() {
      close()
    },
  }
}

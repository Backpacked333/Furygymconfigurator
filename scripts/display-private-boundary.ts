import type { Plugin } from 'vite'
import type { IncomingMessage, ServerResponse } from 'node:http'

/** Runs even when the service is disabled, --mode production is used, or preview is selected.
 * No private service/renderer imports. Default v3's pre-existing Three graph is not replaced. */
export function isPrivateDisplayPath(url: string) {
  let path = url
  try {
    for (let i = 0; i < 4; i++) path = decodeURIComponent(path)
    path = new URL(path.replaceAll('\\', '/').replace(/\/{2,}/g, '/'), 'http://localhost').pathname
  } catch {
    return true
  }
  return /\/(?:src\/(?:render\/display|render-library\/server|image-service\/(?:display|remote-display))(?:\/|$)|render-server(?:\/|$)|src\/display\/(?:session|cloudSession|readiness|operator)(?:\.|$)|scripts\/(?:display-(?:service|renderer|operator)|cloud-display-))/.test(
    path,
  )
}
export function displayPrivateBoundary(): Plugin {
  const deny = (request: IncomingMessage, response: ServerResponse, next: () => void) => {
    if (!isPrivateDisplayPath(request.url ?? '')) return next()
    response.statusCode = 404
    response.setHeader('Cache-Control', 'private, no-store')
    response.end()
  }
  return {
    name: 'fury-private-display-boundary',
    enforce: 'pre',
    configureServer(server) {
      server.middlewares.use(deny)
    },
    configurePreviewServer(server) {
      server.middlewares.use((req, res, next) => {
        let decoded = req.url ?? ''
        try {
          for (let i = 0; i < 4; i++) decoded = decodeURIComponent(decoded)
        } catch {
          decoded = '__fury-display'
        }
        if (decoded.includes('__fury-display')) {
          res.statusCode = 404
          res.end()
          return
        }
        deny(req, res, next)
      })
    },
    generateBundle(_options, bundle) {
      for (const output of Object.values(bundle)) {
        if (output.type !== 'chunk') continue
        for (const [name, info] of Object.entries(output.modules)) {
          if (info.renderedLength > 0 && isPrivateDisplayPath(name))
            throw new Error('Private display module entered a customer bundle.')
        }
        if (
          /__FURY_PRIVATE_DISPLAY__|createPrivateDisplayBackend|openDisplayProcess|createRemoteDisplayBackend|createCloudDisplayService/.test(
            output.code,
          )
        )
          throw new Error('Private display execution entered customer output.')
      }
    },
  }
}

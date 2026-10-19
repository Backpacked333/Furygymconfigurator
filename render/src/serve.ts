import { createReadStream, existsSync, statSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import { extname, join, normalize, resolve } from 'node:path'

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.webp': 'image/webp',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
}

/**
 * Serves the app's production build to the render pages, so the worker always draws with the
 * exact code and textures of the commit it was started from.
 */
export function serveBuild(dir: string, port = 0): Promise<{ url: string; server: Server }> {
  const root = resolve(dir)
  if (!existsSync(join(root, 'index.html')))
    throw new Error(`No build at ${root}. Run \`npm run build\` in the app first.`)
  const server = createServer((req, res) => {
    const path = decodeURIComponent(new URL(req.url ?? '/', 'http://x').pathname)
    let file = normalize(join(root, path))
    if (!file.startsWith(root) || !existsSync(file) || statSync(file).isDirectory())
      file = join(root, 'index.html')
    res.writeHead(200, { 'Content-Type': TYPES[extname(file)] ?? 'application/octet-stream' })
    createReadStream(file).pipe(res)
  })
  return new Promise((done) =>
    server.listen(port, '127.0.0.1', () => {
      const address = server.address()
      const actual = typeof address === 'object' && address ? address.port : port
      done({ url: `http://127.0.0.1:${actual}`, server })
    }),
  )
}

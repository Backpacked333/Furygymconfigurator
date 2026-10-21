/**
 * What scripts/convergence.mjs and scripts/seed-check.mjs share: a page bundled from TypeScript
 * with esbuild (the app's own modules included), served locally, in headless Chromium on
 * SwiftShader's WebGPU. Assets the app imports as `?url` are served from src/ by name.
 */
import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import http from 'node:http'
import { basename } from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadPlaywright } from '../harness.mjs'

const ROOT = fileURLToPath(new URL('../..', import.meta.url))

export async function withPage(entry, run) {
  const esbuild = createRequire(ROOT + 'package.json')('esbuild')
  const assets = new Map()
  const bundle = await esbuild.build({
    entryPoints: [ROOT + entry],
    bundle: true,
    write: false,
    format: 'esm',
    target: 'es2022',
    logLevel: 'warning',
    plugins: [
      {
        name: 'url',
        setup(build) {
          build.onResolve({ filter: /\?url$/ }, (args) => {
            const path = new URL(args.path.replace(/\?url$/, ''), `file://${args.resolveDir}/`)
              .pathname
            assets.set(`/${basename(path)}`, path)
            return { path: `/${basename(path)}`, namespace: 'url' }
          })
          build.onLoad({ filter: /.*/, namespace: 'url' }, (args) => ({
            contents: `export default ${JSON.stringify(args.path)}`,
            loader: 'js',
          }))
        },
      },
    ],
  })
  const js = bundle.outputFiles[0].text
  const server = http.createServer(async (request, response) => {
    if (request.url === '/page.js') {
      response.setHeader('content-type', 'text/javascript')
      response.end(js)
    } else if (assets.has(request.url)) {
      response.end(await readFile(assets.get(request.url)))
    } else {
      response.setHeader('content-type', 'text/html')
      response.end('<!doctype html><script type="module" src="/page.js"></script>')
    }
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { chromium } = loadPlaywright()
  const browser = await chromium.launch({
    headless: true,
    args: [
      '--enable-unsafe-webgpu',
      '--use-webgpu-adapter=swiftshader',
      '--enable-unsafe-swiftshader',
      '--enable-features=Vulkan',
    ],
  })
  try {
    const page = await browser.newPage()
    page.on('pageerror', (error) => console.error('page:', error.message))
    page.on('console', (message) => {
      if (message.type() === 'error' || message.type() === 'warning')
        console.error(`page[${message.type()}]:`, message.text().slice(0, 600))
    })
    await page.goto(`http://127.0.0.1:${server.address().port}/`)
    return await run(page)
  } finally {
    await browser.close()
    server.close()
  }
}

import { createServer } from 'node:http'
import { createReadStream, existsSync, statSync } from 'node:fs'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { chromium, type Page } from 'playwright'
import { ANGLES } from '../../src/lib/cameras'
import { DEFAULT_CONFIG } from '../../src/lib/config'
import { RENDERER_ID, readyPath } from '../../src/lib/renderKey'
import { layersFor } from '../../src/lib/stills'
import { encodeLayer } from './encode'
import { serveBuild } from './serve'
import { LocalStorage, type Storage } from './storage'

/**
 * Browser smoke test of the stills-first page, run in CI on a GPU-less machine:
 *
 * - With stills published (a fixture set for the default build), the hero still is on screen
 *   before any 3D code is requested; switching angles swaps the still; a 3D failure leaves the
 *   stills working.
 * - Without stills, the live view draws the still and the 360 view becomes interactive.
 *
 * Expects two builds: `--live` without VITE_STILLS_BASE and `--published` with
 * VITE_STILLS_BASE=http://127.0.0.1:4599.
 */
const { values: args } = parseArgs({
  options: {
    live: { type: 'string', default: '../dist' },
    published: { type: 'string', default: '../dist-published' },
  },
})
const STILLS_PORT = 4599

async function fixtureStills() {
  const dir = await mkdtemp(join(tmpdir(), 'fury-stills-'))
  const storage: Storage = new LocalStorage(dir)
  const tones = [0x8a, 0x9c, 0xae, 0x78, 0x6a, 0xbc, 0xc8]
  for (const [i, angle] of ANGLES.entries())
    for (const layer of layersFor(DEFAULT_CONFIG, angle)) {
      const channels = layer.kind === 'shell' ? 4 : 3
      const data = Buffer.alloc(320 * 180 * channels, tones[i])
      if (channels === 4) for (let p = 3; p < data.length; p += 4) data[p] = 200
      for (const file of await encodeLayer(
        { data, width: 320, height: 180, channels },
        layer.key,
        RENDERER_ID,
      ))
        await storage.put(file.path, file.body, file.contentType)
    }
  await storage.put(readyPath(), JSON.stringify({ fixture: true }), 'application/json')
  const server = createServer((req, res) => {
    const file = join(dir, decodeURIComponent((req.url ?? '/').split('?')[0]))
    res.setHeader('Access-Control-Allow-Origin', '*')
    if (!file.startsWith(dir) || !existsSync(file) || statSync(file).isDirectory()) {
      res.writeHead(404)
      res.end()
      return
    }
    const type = file.endsWith('.avif')
      ? 'image/avif'
      : file.endsWith('.webp')
        ? 'image/webp'
        : 'application/json'
    res.writeHead(200, { 'Content-Type': type })
    createReadStream(file).pipe(res)
  })
  await new Promise<void>((done) => server.listen(STILLS_PORT, '127.0.0.1', done))
  return server
}

function check(condition: unknown, message: string) {
  if (!condition) throw new Error(`Smoke test failed: ${message}`)
  console.log(`ok - ${message}`)
}

async function open(page: Page, url: string) {
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(e.message))
  page.on('console', (m) => {
    if (m.type() === 'error' && !m.text().includes('Failed to load resource')) errors.push(m.text())
  })
  await page.goto(url)
  return errors
}

const stills = await fixtureStills()
const browser = await chromium.launch({ args: ['--enable-unsafe-swiftshader'] })
const published = await serveBuild(resolve(args.published!))
const live = await serveBuild(resolve(args.live!))
try {
  {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
    // A low-memory device skips warming the 360 view, so software 3D never busies this page.
    // A string, not a function: the TypeScript runner would wrap a function in helpers the page
    // does not have.
    await page.addInitScript({
      content: "Object.defineProperty(navigator, 'deviceMemory', { get: () => 1 })",
    })
    const errors = await open(page, `${published.url}/`)
    await page.waitForSelector('.still img', { timeout: 20_000 })
    // Resource timing: the still finished loading before the 3D bundle was even requested.
    const timing = await page.evaluate(() => {
      const entries = performance.getEntriesByType('resource') as PerformanceResourceTiming[]
      const still = entries.find((e) => e.name.includes(':4599/') && !e.name.endsWith('.json'))
      const three = entries.find((e) => /\/assets\/three-[^/]+\.js$/.test(e.name))
      return { still: still?.responseEnd ?? null, three: three?.startTime ?? null }
    })
    check(
      timing.still !== null && (timing.three === null || timing.three > timing.still),
      `the first still loads before any 3D code is requested (${JSON.stringify(timing)})`,
    )
    const first = await page.locator('.still img').first().getAttribute('src')
    await page.locator('#angle-rear').click()
    await page.waitForFunction(
      (src) => document.querySelector('.still:last-child img')?.getAttribute('src') !== src,
      first,
      { timeout: 10_000 },
    )
    check(true, 'choosing an angle swaps the still')
    check(errors.length === 0, `no page errors (${errors.join(' | ')})`)
    await page.close()
  }
  {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
    // The 3D bundle never arrives: the page must keep working on stills alone.
    await page.route(/\/assets\/(three|Scene)-[^/]+\.js$/, (route) => route.abort())
    await open(page, `${published.url}/`)
    await page.waitForSelector('.still img', { timeout: 20_000 })
    await page
      .getByRole('button', { name: /360°/ })
      .first()
      .click({ noWaitAfter: true, timeout: 120_000 })
    await page.waitForSelector('.toast', { timeout: 20_000 })
    const back = await page.locator('.still-layer:not(.is-hidden) .still img').count()
    check(back > 0, 'a 3D failure in the 360 view returns to the stills')
    await page.close()
  }
  {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
    // Lite: a GPU-less runner draws in software, where the heavier tiers take seconds per
    // frame. This checks that the live fallback and the 360 view work, not how fast they draw.
    const errors = await open(page, `${live.url}/?quality=lite`)
    await page.waitForSelector('.scene-layer canvas', { timeout: 60_000 })
    check(true, 'without published stills, the live view draws the still')
    // Software rendering keeps the page busy; the click lands, so don't wait on the page after it.
    await page
      .getByRole('button', { name: /Explore in 360°/ })
      .click({ noWaitAfter: true, timeout: 120_000 })
    await page.waitForFunction(
      () => document.querySelector('.scene-layer canvas')?.getAttribute('tabindex') === '0',
      null,
      { timeout: 60_000 },
    )
    check(true, 'the 360 view becomes interactive')
    check(errors.length === 0, `no page errors (${errors.join(' | ')})`)
    await page.close()
  }
} finally {
  await browser.close()
  published.server.close()
  live.server.close()
  stills.close()
}

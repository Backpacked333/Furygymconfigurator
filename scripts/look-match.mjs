#!/usr/bin/env node
/**
 * Measures how closely the live 360° raster matches the path-traced stills: for each gallery
 * angle, the still the gallery shows and the 360° View opened at that angle, at the same camera
 * and stage size, compared in the page (scripts/harness.mjs pageStats):
 *
 * - Δ stops: the live view's mean log₂ luminance less the still's (+ is the live view brighter);
 * - shade: the same over the still's darker half, where the open sky's share of the light shows;
 * - R, B: each channel's ratio to green against the still's (white balance), in percent;
 * - SSIM of luma, for structure (noise, missing detail, framing).
 *
 * The stills come from a render server (`cd render-server && python -m fury_render.local
 * --device cpu --port 8787` on this machine). The page talks to it directly as `?cloud=`. Its
 * frame cache keeps the stills between runs, so only the first run waits for Cycles.
 *
 *   node scripts/look-match.mjs [options]
 *
 * Options:
 *   --server <url>        render server (default http://127.0.0.1:8787)
 *   --quality <tier>      the raster tier: ultra | high | lite (default high)
 *   --design <id>         default, or a signature build's id (config.ts SIGNATURES)
 *   --environment <id>    the setting, instead of the design's own (config.ts ENVIRONMENTS)
 *   --angles <list>       angle ids (default all nine, gallery.ts GALLERY_ANGLES)
 *   --viewport <w>x<h>    the page's size (default 1400x900: an 872×545 stage); the same size
 *                         run to run, so stills rendered for it are reused from the server's cache
 *   --out <dir>           where the image pairs and results.json go (default look-match/ in the
 *                         system's temporary directory)
 *   --stops <n>           the allowed |Δ stops| (default 0.1)
 *   --balance <n>         the allowed |R| and |B| (default 0.02)
 *   --no-build            use dist/ as it is
 *   --dev                 serve with the dev server instead of a build (for trying changes)
 *   --verbose             the page's console
 *
 * Exits non-zero when an angle misses either tolerance.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import {
  BARE_STAGE,
  build,
  stageBox,
  launch,
  loadApp,
  pageStats,
  shootStage,
  sleep,
} from './harness.mjs'

const { values: options } = parseArgs({
  allowNegative: true,
  options: {
    server: { type: 'string', default: 'http://127.0.0.1:8787' },
    quality: { type: 'string', default: 'high' },
    design: { type: 'string', default: 'default' },
    environment: { type: 'string' },
    angles: { type: 'string' },
    viewport: { type: 'string', default: '1400x900' },
    out: { type: 'string', default: join(tmpdir(), 'look-match') },
    stops: { type: 'string', default: '0.1' },
    balance: { type: 'string', default: '0.02' },
    build: { type: 'boolean', default: true },
    dev: { type: 'boolean', default: false },
    verbose: { type: 'boolean', default: false },
    help: { type: 'boolean', short: 'h', default: false },
  },
})

const started = Date.now()
const say = (line) =>
  console.log(`${((Date.now() - started) / 1000).toFixed(0).padStart(5)} s  ${line}`)
/** The longest a still or a settled live view is waited for. */
const STILL_MS = 30 * 60_000
const SETTLE_MS = 5 * 60_000
/** Frames this close (mean absolute difference, 0–1) count as the same. */
const SAME = 0.0015

/** The still of `angle` whole on the stage, at the still tier or better. */
async function stillShown(page, angle) {
  await page.waitForFunction(
    (angle) => {
      const layers = [...document.querySelectorAll('.still-layers img.still-layer')]
      const shown = layers.find((img) => img.classList.contains('is-shown'))
      return (
        layers.length === 1 &&
        shown &&
        shown.dataset.angle === angle &&
        (shown.dataset.tier === 'still' || shown.dataset.tier === 'export') &&
        !shown.classList.contains('is-entering') &&
        !shown.classList.contains('is-loading') &&
        shown.complete &&
        shown.naturalWidth > 0
      )
    },
    angle,
    { timeout: STILL_MS, polling: 500 },
  )
  await sleep(500)
}

/** Screenshots of the stage until two in a row match: the live view has come to rest. */
async function settledShot(page) {
  const deadline = Date.now() + SETTLE_MS
  let last = await shootStage(page)
  let same = 0
  while (Date.now() < deadline) {
    await sleep(1500)
    const next = await shootStage(page)
    const diff = await page.evaluate(
      ([a, b]) => window.__diff(a, b),
      [last.toString('base64'), next.toString('base64')],
    )
    last = next
    same = diff < SAME ? same + 1 : 0
    if (same >= 2) return last
  }
  say('  the live view did not come to rest; measuring its last frame')
  return last
}

const pct = (x) => `${x >= 0 ? '+' : ''}${(x * 100).toFixed(1)} %`
const stops = (x) => `${x >= 0 ? '+' : ''}${x.toFixed(2)}`

async function main() {
  if (options.help) {
    const source = await readFile(fileURLToPath(import.meta.url), 'utf8')
    console.log(/\/\*\*([\s\S]*?)\*\//.exec(source)[1].replace(/^ \* ?/gm, ''))
    return
  }
  const { config: lib, gallery } = await loadApp()
  const signature = lib.SIGNATURES.find((s) => s.id === options.design)
  if (options.design !== 'default' && !signature)
    throw new Error(
      `--design takes default or one of ${lib.SIGNATURES.map((s) => s.id).join(', ')}`,
    )
  const base = signature ? signature.config : lib.DEFAULT_CONFIG
  if (options.environment && !lib.ENVIRONMENTS.some((e) => e.id === options.environment))
    throw new Error(`--environment takes one of ${lib.ENVIRONMENTS.map((e) => e.id).join(', ')}`)
  const config = { ...base, environment: options.environment ?? base.environment }
  const ids = gallery.GALLERY_ANGLES.map((a) => a.id)
  const angles = options.angles ? options.angles.split(',').map((a) => a.trim()) : ids
  for (const angle of angles)
    if (!ids.includes(angle)) throw new Error(`no angle "${angle}": ${ids.join(', ')}`)
  const [width, height] = options.viewport.split('x').map(Number)
  await mkdir(options.out, { recursive: true })
  if (!options.dev) build(options.build)

  const app = await launch({ dev: options.dev })
  const results = []
  try {
    const page = await app.browser.newPage({
      viewport: { width, height },
      deviceScaleFactor: 1,
    })
    page.on('console', (message) => {
      if (options.verbose || message.type() === 'error')
        say(`  page: ${message.text().slice(0, 300)}`)
    })
    page.on('pageerror', (error) => say(`  page error: ${error.message}`))
    await page.addInitScript(pageStats)
    const params = new URLSearchParams({ quality: options.quality, cloud: options.server })
    await page.goto(`${app.base}/?${params}#c=${lib.encodeConfig(config)}`)
    await page.addStyleTag({ content: BARE_STAGE })
    await page.waitForSelector('.film-tile')
    // Fitted once the page has laid itself out round its first still.
    await page.waitForSelector('img.still-layer.is-shown', { timeout: STILL_MS })
    const fitted = await stageBox(page)
    say(
      `${options.design} in ${config.environment}, ${options.quality}, stage ${fitted.width}×${fitted.height}, stills from ${options.server}`,
    )
    for (const angle of angles) {
      const index = ids.indexOf(angle)
      await page.locator('.film-tile').nth(index).click()
      say(`${angle}: waiting for its still`)
      await stillShown(page, angle)
      const still = await shootStage(page)
      // Hidden with the stage's overlays (BARE_STAGE), so clicked by event rather than by pointer.
      await page.locator('button[aria-label="360° View"]').dispatchEvent('click')
      await page.waitForSelector('.still-layers', { state: 'detached', timeout: SETTLE_MS })
      const live = await settledShot(page)
      await writeFile(join(options.out, `${angle}-still.png`), still)
      await writeFile(join(options.out, `${angle}-live.png`), live)
      const stats = await page.evaluate(
        ([a, b]) => window.__stats(a, b),
        [still.toString('base64'), live.toString('base64')],
      )
      results.push({ angle, ...stats })
      say(
        `${angle}: ${stops(stats.stops)} stop (shade ${stops(stats.shade)}), R ${pct(stats.red)}, B ${pct(stats.blue)}, SSIM ${stats.ssim.toFixed(3)}`,
      )
      await page.locator('button[aria-label="Close the 360° View"]').dispatchEvent('click')
      await page.waitForFunction(
        () => !document.querySelector('.live-freeze.is-hold, .live-freeze.is-fading'),
        null,
        { timeout: STILL_MS },
      )
    }
  } finally {
    await app.close()
  }
  const tolerance = { stops: Number(options.stops), balance: Number(options.balance) }
  const passes = (r) =>
    Math.abs(r.stops) <= tolerance.stops &&
    Math.abs(r.red) <= tolerance.balance &&
    Math.abs(r.blue) <= tolerance.balance
  const table = [
    '| Angle | Δ stops | Δ in shade | R | B | SSIM | Within |',
    '| --- | --- | --- | --- | --- | --- | --- |',
    ...results.map(
      (r) =>
        `| ${gallery.GALLERY_ANGLES.find((a) => a.id === r.angle).label} | ${stops(r.stops)} | ${stops(r.shade)} | ${pct(r.red)} | ${pct(r.blue)} | ${r.ssim.toFixed(3)} | ${passes(r) ? 'yes' : 'no'} |`,
    ),
  ].join('\n')
  await writeFile(
    join(options.out, 'results.json'),
    JSON.stringify({ options, environment: config.environment, results }, null, 2),
  )
  console.log(`\n${table}\n\nImages and results.json in ${options.out}`)
  if (!results.every(passes)) process.exitCode = 1
}

main().catch((error) => {
  console.error(error.stack ?? error)
  process.exit(2)
})

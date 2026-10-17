#!/usr/bin/env node
/**
 * Bakes the gallery's path-traced stills ahead of time, so a design's first picture is its
 * finished still the moment the page opens (src/lib/bakedStills.ts, index.html's preload).
 *
 * For each design it opens the built app in headless Chromium in bake mode (src/lib/bake.ts):
 * the page builds the scene as any visit does, meters its exposure, and asks the render server
 * for every gallery angle at every stage shape at the export tier. The page talks to the server
 * through this script's own proxy, on the page's origin, so any server can be named (the page
 * bakes only on its own machine's address, and no browser origin needs allowing). The script
 * takes the finished WebP masters, writes narrower widths for `srcset` (with sharp when it is
 * installed, else with the browser's own resampler and WebP encoder), stores them in Vercel Blob
 * or under public/stills, and records them in src/stills.manifest.json under the renderer version
 * they were rendered by. Rebuild afterwards: index.html's preload of the hero still is written at
 * build.
 *
 * Full bakes belong in Vercel Blob (--blob): under public/ they ship in every deploy and stay in
 * the repository's history for good, a new set with every renderer version. public/stills is for
 * quick bakes and local checks.
 *
 * The renderer version is a hash of the render sources (scripts/render-version.ts): the script
 * refuses to bake while they have uncommitted changes, since a deploy built from the commit would
 * hash to another version and ignore the bake (--allow-dirty bakes anyway, for a local check).
 *
 *   npm run bake -- [options]          every still at the export tier (1024 samples, 2400 px)
 *   npm run bake:quick -- [options]    small stills at 64 samples, for CI and end-to-end checks
 *
 * Options:
 *   --server <url>        render server (default http://127.0.0.1:8787). The deployed gateway cuts
 *                         every render at 15 seconds unless FURY_BAKE_TOKEN holds the token it was
 *                         deployed with (render-server/modal_app.py), which this script sends.
 *   --designs <which>     default | signatures | all (default: all, the default design and the
 *                         signature builds)
 *   --finishes            also every other finish of each design
 *   --aspects <list>      stage shapes: wide,tall (default both)
 *   --quick               640 px stills at 64 samples
 *   --blob                upload to Vercel Blob (BLOB_READ_WRITE_TOKEN, @vercel/blob)
 *   --out <dir>           without --blob, where the images go (default public/stills, at /stills)
 *   --base-url <url>      the address --out is served at, when it is not under public/
 *   --quality <tier>      the raster tier the exposure is metered against (default high); the
 *                         scene the stills show, plants included, is the same at every tier
 *   --fresh               start the manifest afresh, forgetting this version's earlier bakes
 *   --no-build            use dist/ as it is instead of building first
 *   --allow-dirty         bake although the render sources have uncommitted changes
 *   --timeout <minutes>   per design (default 20 quick, 120 otherwise)
 *   --verbose             the page's stills log as it renders
 */
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const MANIFEST = join(ROOT, 'src/stills.manifest.json')
const PUBLIC = join(ROOT, 'public')
/** The narrower widths written below each master, for `srcset`; the master is the widest. */
const WIDTHS = [320, 640, 960, 1280, 1600, 1920]
/** Where the page reaches the render server: this script's proxy, on the page's own origin. */
const PROXY = '/render-proxy'
/** A page that has not even started its bake by now never will (its scripts did not load). */
const START_MS = 60_000
/** WebP quality of the narrower widths (the master is the server's own, at 90). */
const WEBP_QUALITY = 86
/** The chromium this environment ships, when Playwright has none of its own. */
const CHROMIUM = '/opt/pw-browsers/chromium-1194/chrome-linux/chrome'

const { values: options } = parseArgs({
  allowNegative: true,
  options: {
    server: { type: 'string', default: 'http://127.0.0.1:8787' },
    designs: { type: 'string', default: 'all' },
    finishes: { type: 'boolean', default: false },
    aspects: { type: 'string', default: 'wide,tall' },
    quick: { type: 'boolean', default: false },
    out: { type: 'string', default: 'public/stills' },
    'base-url': { type: 'string' },
    blob: { type: 'boolean', default: false },
    quality: { type: 'string', default: 'high' },
    fresh: { type: 'boolean', default: false },
    build: { type: 'boolean', default: true },
    'allow-dirty': { type: 'boolean', default: false },
    timeout: { type: 'string' },
    verbose: { type: 'boolean', default: false },
    help: { type: 'boolean', short: 'h', default: false },
  },
})

const started = Date.now()
const elapsed = () => `${((Date.now() - started) / 1000).toFixed(0).padStart(5)} s`
const say = (line) => console.log(`${elapsed()}  ${line}`)
const sleep = (ms) => new Promise((done) => setTimeout(done, ms))
class Refusal extends Error {}
const refuse = (message) => {
  throw new Refusal(message)
}

function checkOptions() {
  if (!['default', 'signatures', 'all'].includes(options.designs))
    refuse(`--designs takes default, signatures or all, not "${options.designs}".`)
  const aspects = options.aspects.split(',').map((a) => a.trim())
  if (!aspects.length || aspects.some((a) => a !== 'wide' && a !== 'tall'))
    refuse(`--aspects takes wide, tall or both ("wide,tall"), not "${options.aspects}".`)
  if (!['ultra', 'high', 'lite'].includes(options.quality))
    refuse(`--quality takes ultra, high or lite, not "${options.quality}".`)
  try {
    new URL(options.server)
  } catch {
    refuse(`--server needs a URL, like http://127.0.0.1:8787, not "${options.server}".`)
  }
  const minutes = Number(options.timeout ?? (options.quick ? 20 : 120))
  if (!(minutes > 0)) refuse(`--timeout takes minutes, not "${options.timeout}".`)
  return { aspects: [...new Set(aspects)], timeoutMs: minutes * 60_000 }
}

/** Where the images go and the address they are served at: a folder, or Vercel Blob. */
async function storage() {
  if (options.blob) {
    const token = process.env.BLOB_READ_WRITE_TOKEN
    if (!token)
      refuse(
        'Uploading to Vercel Blob needs BLOB_READ_WRITE_TOKEN: copy it from the project\'s Blob store (Vercel dashboard → Storage → the store → ".env.local"), then run BLOB_READ_WRITE_TOKEN=… npm run bake -- --blob.',
      )
    let put
    try {
      ;({ put } = await import('@vercel/blob'))
    } catch {
      refuse(
        'Uploading to Vercel Blob needs the @vercel/blob package: npm install --no-save @vercel/blob, then run again. Without --blob the stills are written to public/stills.',
      )
    }
    const upload = async (path, bytes, contentType) =>
      (
        await put(`stills/${path}`, bytes, {
          access: 'public',
          contentType,
          addRandomSuffix: false,
          allowOverwrite: true,
          cacheControlMaxAge: 31_536_000,
          token,
        })
      ).url
    // The store's own address, which the manifest serves every still from: learned from a note
    // put beside them, as the store names it.
    const note = await upload('README.txt', 'Baked stills: scripts/bake-stills.mjs\n', 'text/plain')
    return {
      describe: 'Vercel Blob',
      local: false,
      base: note.slice(0, -'/README.txt'.length),
      store: (path, bytes) => upload(path, bytes, 'image/webp'),
    }
  }
  const out = isAbsolute(options.out) ? options.out : resolve(ROOT, options.out)
  const inPublic = relative(PUBLIC, out)
  let base = options['base-url']?.replace(/\/$/, '')
  if (!base) {
    if (inPublic.startsWith('..') || isAbsolute(inPublic))
      refuse(`--out ${options.out} is not under public/: say where it is served with --base-url.`)
    base = `/${inPublic.split(sep).join('/')}`.replace(/\/$/, '')
  }
  return {
    describe: `${relative(ROOT, out) || out} (served at ${base})`,
    local: true,
    out,
    base,
    async store(path, bytes) {
      const file = join(out, ...path.split('/'))
      await mkdir(dirname(file), { recursive: true })
      await writeFile(file, bytes)
      return `${base}/${path}`
    },
  }
}

/** sharp when it is installed; null to resample in the browser instead. */
async function loadSharp() {
  try {
    return (await import('sharp')).default
  } catch {
    return null
  }
}

/** Playwright: this environment's global install, else the project's or the machine's package. */
function loadPlaywright() {
  const require = createRequire(import.meta.url)
  for (const id of ['/opt/node22/lib/node_modules/playwright', 'playwright']) {
    try {
      return require(id)
    } catch {
      // Try the next.
    }
  }
  refuse(
    'Baking drives headless Chromium with Playwright: npm install --no-save playwright && npx playwright install chromium, then run again.',
  )
}

/**
 * The render server's and the app's shared code, in TypeScript: Node strips the types itself
 * (22.18 on), or Vite loads them.
 */
async function loadSources() {
  try {
    return {
      version: await import('./render-version.ts'),
      manifest: await import('../src/lib/stillsManifest.ts'),
    }
  } catch {
    const { createServer } = await import('vite')
    const vite = await createServer({
      root: ROOT,
      logLevel: 'error',
      server: { middlewareMode: true },
      appType: 'custom',
      // Two modules of plain TypeScript: nothing to scan or pre-bundle.
      optimizeDeps: { noDiscovery: true, entries: [] },
    })
    try {
      return {
        version: await vite.ssrLoadModule('/scripts/render-version.ts'),
        manifest: await vite.ssrLoadModule('/src/lib/stillsManifest.ts'),
      }
    } finally {
      await vite.close()
    }
  }
}

/**
 * The render sources' uncommitted changes, edits and new files alike, or null outside a git
 * checkout: a bake is of the sources as committed, so a deploy built from them finds it.
 */
function uncommitted({ RENDER_SOURCES: sources, isRenderSource }) {
  const result = spawnSync(
    'git',
    [
      'status',
      '--porcelain',
      '--untracked-files=all',
      '--',
      ...sources.directories,
      ...sources.files,
    ],
    { cwd: ROOT, encoding: 'utf8' },
  )
  if (result.status !== 0) return null
  // Tests aside, as the version leaves them out ("R old -> new" for a rename).
  return result.stdout
    .split('\n')
    .filter((line) => line && isRenderSource(line.slice(3).split(' -> ').pop().replace(/"/g, '')))
}

/** Whether the server is the deployed gateway, which cuts renders short without a bake token. */
async function checkServer() {
  let health = null
  try {
    const response = await fetch(`${options.server.replace(/\/$/, '')}/health`, {
      signal: AbortSignal.timeout(120_000),
    })
    if (!response.ok) say(`The render server answered /health with ${response.status}; going on.`)
    health = await response.json().catch(() => null)
  } catch (error) {
    refuse(
      `No render server at ${options.server} (${error.cause?.code ?? error.cause?.message ?? error.message}). Start one (render-server/README.md), or name another with --server.`,
    )
  }
  if (health?.service !== 'gateway') return
  if (process.env.FURY_BAKE_TOKEN)
    say('The server is the deployed gateway: the bake holds one of its sessions until it is done.')
  else if (!options.quick)
    refuse(
      `${options.server} is the deployed gateway, which cuts every render at 15 seconds: export-tier stills (1024 samples at 2400 px) take up to a minute. Run with FURY_BAKE_TOKEN set to the token the gateway was deployed with (FURY_BAKE_TOKEN in render-server/modal_app.py), or bake against a render server of your own.`,
    )
}

function build() {
  if (!options.build) {
    if (!existsSync(join(ROOT, 'dist/index.html')))
      refuse('There is no dist/ to bake from: run without --no-build.')
    say('Using dist/ as it is.')
    return
  }
  say('Building the app…')
  const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm'
  const result = spawnSync(npm, ['run', 'build'], { cwd: ROOT, stdio: 'inherit' })
  if (result.status !== 0) refuse('The build failed.')
}

/**
 * The manifest to add to: this version's, stored where this run stores, or a new one (another
 * version's entries are retired, and entries stored elsewhere are not this run's to keep).
 */
async function loadManifest(version, base) {
  let current = null
  try {
    current = JSON.parse(await readFile(MANIFEST, 'utf8'))
  } catch {
    // None yet, or unreadable: a new one.
  }
  const same =
    current?.version === version &&
    current.base === base &&
    JSON.stringify(current.widths) === JSON.stringify(WIDTHS)
  if (same && !options.fresh) {
    const stills = Object.fromEntries(
      Object.entries(current.stills ?? {}).map(([design, entries]) => [design, { ...entries }]),
    )
    return { looks: {}, ...current, stills }
  }
  if (current?.version && current.version !== version)
    say(`The manifest was baked by renderer ${current.version}: starting one for ${version}.`)
  else if (current?.version && !same && !options.fresh)
    say(`The manifest's stills are stored elsewhere (${current.base}): starting one for ${base}.`)
  return { version, base, widths: WIDTHS, looks: {}, stills: {} }
}

/** Written with its keys sorted, each still on a line, so a bake changes only what it changed. */
async function writeManifest(manifest) {
  const sorted = (object) => Object.fromEntries(Object.entries(object ?? {}).sort())
  const ordered = {
    version: manifest.version,
    base: manifest.base,
    widths: manifest.widths,
    ...(manifest.hero ? { hero: manifest.hero } : {}),
    looks: sorted(manifest.looks),
    stills: Object.fromEntries(
      Object.entries(manifest.stills)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([design, entries]) => [design, sorted(entries)]),
    ),
  }
  const text = JSON.stringify(ordered, null, 2)
    // A still's four numbers, and the widths, on one line each.
    .replace(/\[\n\s+("[0-9a-f]+"),\n\s+(\d+),\n\s+(\d+),\n\s+(\d+)\n\s+\]/g, '[$1, $2, $3, $4]')
    .replace(/"widths": \[[^\]]*\]/, (widths) =>
      widths.replace(/\s+/g, ' ').replace('[ ', '[').replace(' ]', ']'),
    )
  await writeFile(MANIFEST, `${text}\n`)
}

/** Set up in each bake page before it loads: what the script hands it, and a way back. */
function pageSetup(looks) {
  // Looks baked already keep their gains: one exposure for a look, whatever the design.
  window.__bakeLooks = looks
  /** A Blob's bytes as base64, to hand to the script. */
  window.__bakeBase64 = async (blob) => {
    const bytes = new Uint8Array(await blob.arrayBuffer())
    let text = ''
    for (let i = 0; i < bytes.length; i += 0x8000)
      text += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
    return btoa(text)
  }
}

/** A result's master image (the server's WebP), from the page. */
async function masterOf(page, index) {
  const base64 = await page.evaluate(
    (i) => window.__bakeBase64(window.__bake.results[i].image),
    index,
  )
  return Buffer.from(base64, 'base64')
}

/** A narrower width of an image: sharp, or the page's resampler and WebP encoder. */
async function narrower({ sharp, page, index, master, width, height }) {
  if (sharp)
    return sharp(master)
      .resize({ width, height })
      .webp({ quality: WEBP_QUALITY, effort: 5 })
      .toBuffer()
  const base64 = await page.evaluate(
    async ({ index, width, height, quality }) => {
      const bitmap = await createImageBitmap(window.__bake.results[index].image, {
        resizeWidth: width,
        resizeHeight: height,
        resizeQuality: 'high',
      })
      const canvas = new OffscreenCanvas(width, height)
      canvas.getContext('2d').drawImage(bitmap, 0, 0)
      bitmap.close()
      const webp = await canvas.convertToBlob({ type: 'image/webp', quality })
      if (webp.type !== 'image/webp') throw new Error('this browser cannot encode WebP')
      return window.__bakeBase64(webp)
    },
    { index, width, height, quality: WEBP_QUALITY / 100 },
  )
  return Buffer.from(base64, 'base64')
}

/**
 * A master's hash, which names its files (stillsManifest.ts fileOf): a file once served never
 * changes (it is cached for a year), and a bake that renders it again writes a new one.
 */
const hashOf = (master) => createHash('sha256').update(master).digest('hex').slice(0, 8)

/** Bakes one design in its own page: the page's report, once every still is in. */
async function bakeDesign({ context, base, design, aspects, timeoutMs, looks }) {
  const page = await context.newPage()
  page.on('console', (message) => {
    const text = message.text()
    if (message.type() === 'error' || (options.verbose && /\[stills\]|\[cloud\]/.test(text)))
      say(`  page: ${text.slice(0, 400)}`)
  })
  page.on('pageerror', (error) => say(`  page error: ${error.message}`))
  await page.addInitScript(pageSetup, looks)
  const params = new URLSearchParams({
    bake: '1',
    cloud: `${base}${PROXY}`,
    quality: options.quality,
    aspects: aspects.join(','),
  })
  if (options.quick) params.set('quick', '1')
  if (design.hero) params.set('hero', design.hero.join(','))
  if (options.verbose) params.set('traceStats', '1')
  await page.goto(`${base}/?${params}#c=${design.encoded}`, { waitUntil: 'domcontentloaded' })
  const begun = Date.now()
  const deadline = begun + timeoutMs
  let seen = -1
  for (;;) {
    const report = await page.evaluate(() => {
      const bake = window.__bake
      if (!bake) return null
      const { results, ...rest } = bake
      return {
        ...rest,
        done: results.length,
        last: results.at(-1) && {
          angle: results.at(-1).angle,
          aspect: results.at(-1).aspect,
          width: results.at(-1).width,
          height: results.at(-1).height,
          renderMs: results.at(-1).renderMs,
          cached: results.at(-1).cached,
        },
      }
    })
    if (report && report.done !== seen) {
      seen = report.done
      if (report.last) {
        const { angle, aspect, width, height, renderMs, cached } = report.last
        say(
          `  ${report.done}/${report.total} ${angle} ${aspect} ${width}×${height}: ${cached ? 'from the server cache' : `rendered in ${(renderMs / 1000).toFixed(1)} s`}`,
        )
      } else if (report.state === 'rendering')
        say(`  scene captured and metered: ${report.total} stills to render`)
    }
    if (report?.state === 'done') return { page, report }
    if (!report && Date.now() - begun > START_MS) {
      await page.close()
      throw new Error('the page did not start baking (did its scripts load?)')
    }
    if (report?.state === 'failed') {
      await page.close()
      throw new Error(report.error || 'the bake failed')
    }
    if (Date.now() > deadline) {
      await page.close()
      throw new Error(`no answer within ${Math.round(timeoutMs / 60_000)} minutes`)
    }
    await sleep(1000)
  }
}

async function main() {
  if (options.help) {
    const source = await readFile(fileURLToPath(import.meta.url), 'utf8')
    console.log(/\/\*\*([\s\S]*?)\*\//.exec(source)[1].replace(/^ \* ?/gm, ''))
    return
  }
  const { aspects, timeoutMs } = checkOptions()
  const sources = await loadSources()
  const { fileOf, slotOf } = sources.manifest
  const changed = uncommitted(sources.version)
  if (changed?.length && !options['allow-dirty'])
    refuse(
      `The render sources have uncommitted changes:\n  ${changed.slice(0, 12).join('\n  ')}${changed.length > 12 ? `\n  … and ${changed.length - 12} more` : ''}\nA bake is keyed by a hash of these files, and a deploy built from the commit would hash to another version and ignore it. Commit them first (or run with --allow-dirty for a local check).`,
    )
  const sourced = sources.version.renderVersion(ROOT)
  const store = await storage()
  const sharp = await loadSharp()
  const { chromium } = loadPlaywright()
  await checkServer()
  build()

  const { preview } = await import('vite')
  const target = options.server.replace(/\/$/, '')
  const token = process.env.FURY_BAKE_TOKEN
  const server = await preview({
    root: ROOT,
    logLevel: 'warn',
    preview: {
      host: '127.0.0.1',
      port: 4190,
      strictPort: false,
      open: false,
      // The render server, on the page's own origin: server to server, no browser origin to allow.
      proxy: {
        [PROXY]: {
          target,
          changeOrigin: true,
          rewrite: (path) => path.slice(PROXY.length) || '/',
          proxyTimeout: 30 * 60_000,
          timeout: 30 * 60_000,
          configure(proxy) {
            proxy.on('proxyReq', (request) => {
              request.removeHeader('origin')
              request.removeHeader('referer')
              if (token) request.setHeader('x-fury-bake', token)
            })
          },
        },
      },
    },
  })
  const base = server.resolvedUrls.local[0].replace(/\/$/, '')
  const browser = await chromium.launch({
    executablePath: process.env.CHROMIUM_PATH ?? (existsSync(CHROMIUM) ? CHROMIUM : undefined),
    // The same software GPU on every machine: the raster the exposure is metered against does
    // not depend on who bakes.
    args: [
      '--use-gl=angle',
      '--use-angle=swiftshader',
      '--enable-unsafe-swiftshader',
      '--ignore-gpu-blocklist',
      ...(process.getuid?.() === 0 ? ['--no-sandbox'] : []),
    ],
  })
  const failed = []
  let manifest = null
  /** Designs baked and recorded in this run: only then is anything pruned. */
  let written = 0
  try {
    // One context: every page names the same render session (in local storage), so one GPU
    // container renders every design, warm after the first.
    const context = await browser.newContext({
      viewport: { width: 1440, height: 900 },
      deviceScaleFactor: 1,
    })
    const lister = await context.newPage()
    await lister.goto(`${base}/?bake=list`, { waitUntil: 'domcontentloaded' })
    await lister.waitForFunction(() => window.__bakeDesigns && window.__bake?.version)
    const { designs: all, version } = await lister.evaluate(() => ({
      designs: window.__bakeDesigns,
      version: window.__bake.version,
    }))
    await lister.close()
    if (version !== sourced)
      refuse(
        `The app in dist/ is renderer ${version}, but the render sources are renderer ${sourced}: ${options.build ? 'the build did not take them in' : 'run without --no-build'}. A bake of it would be ignored by the next build.`,
      )
    const designs = all.filter(
      (d) =>
        (options.designs === 'all' ||
          (options.designs === 'default' ? d.group === 'default' : d.group === 'signature')) &&
        (options.finishes || !d.variant),
    )
    // Where this run's files are served from: one folder (or Blob prefix) per version.
    const stillsBase = `${store.base}/${version}`
    manifest = await loadManifest(version, stillsBase)
    say(
      `Baking ${designs.length} design${designs.length === 1 ? '' : 's'} × ${aspects.join(' and ')} with renderer ${version}, ${options.quick ? 'quick (64 samples, 640 px)' : 'export tier (1024 samples, 2400 px)'}, on ${options.server}, into ${store.describe}${sharp ? '' : '; sharp is not installed, so the narrower widths are resampled by Chromium'}.`,
    )
    for (const [i, design] of designs.entries()) {
      say(`[${i + 1}/${designs.length}] ${design.name}`)
      const begun = Date.now()
      let page
      try {
        const baked = await bakeDesign({
          context,
          base,
          design,
          aspects,
          timeoutMs,
          looks: manifest.looks,
        })
        page = baked.page
        const { report } = baked
        if (report.version !== version)
          throw new Error(`the page is renderer ${report.version}, not ${version}`)
        // Everything but the images, which come over one at a time.
        const results = await page.evaluate(() =>
          window.__bake.results.map((result) => ({ ...result, image: null })),
        )
        let bytes = 0
        const stills = {}
        for (const [index, result] of results.entries()) {
          const master = await masterOf(page, index)
          const hash = hashOf(master)
          const widths = [...WIDTHS.filter((w) => w < result.width), result.width]
          for (const w of widths) {
            const h = Math.round((result.height * w) / result.width)
            const image =
              w === result.width
                ? master
                : await narrower({ sharp, page, index, master, width: w, height: h })
            bytes += image.length
            const file = `${report.design}/${fileOf(result.angleKey, result.aspect, w, hash)}`
            const url = await store.store(`${version}/${file}`, image)
            // Every file where the manifest will look for it (Blob names them as asked).
            if (url !== `${stillsBase}/${file}`)
              throw new Error(`${file} was stored at ${url}, not under ${stillsBase}`)
          }
          stills[slotOf(result.angleKey, result.aspect)] = [
            hash,
            result.width,
            result.height,
            result.samples,
          ]
        }
        manifest.stills[report.design] = { ...manifest.stills[report.design], ...stills }
        if (design.id === 'default')
          manifest.hero = { design: report.design, encoded: design.encoded }
        if (report.lighting && report.gains && !manifest.looks[report.lighting])
          manifest.looks[report.lighting] = report.gains
        await writeManifest(manifest)
        written++
        say(
          `  ${results.length} stills, ${(bytes / 1e6).toFixed(1)} MB in all, in ${((Date.now() - begun) / 1000).toFixed(0)} s`,
        )
      } catch (error) {
        failed.push(design.name)
        say(`  ${design.name} was not baked: ${error.message}`)
      } finally {
        await page?.close()
      }
    }
    // Pruned only after a bake that wrote the manifest: a run that baked nothing keeps the
    // images the manifest on disk still lists.
    if (store.local && written) await prune(store, manifest, fileOf)
  } finally {
    await browser.close()
    await server.close()
  }
  const total = Object.values(manifest?.stills ?? {}).reduce(
    (sum, entries) => sum + Object.keys(entries).length,
    0,
  )
  say(
    `The manifest (src/stills.manifest.json) lists ${total} stills of renderer ${manifest?.version}. Rebuild (npm run build) for index.html to preload the hero still.`,
  )
  if (failed.length) {
    say(`Not baked: ${failed.join(', ')}.`)
    process.exitCode = 1
  }
}

/**
 * Removes what the manifest no longer refers to from the stills folder: images of other renderer
 * versions, and ones a later bake of the same still replaced.
 */
async function prune({ out }, manifest, fileOf) {
  const kept = new Set(
    Object.entries(manifest.stills).flatMap(([design, entries]) =>
      Object.entries(entries).flatMap(([slot, [hash, width]]) => {
        const [angleKey, aspect] = slot.split('|')
        return [...manifest.widths.filter((w) => w < width), width].map(
          (w) => `${manifest.version}/${design}/${fileOf(angleKey, aspect, w, hash)}`,
        )
      }),
    ),
  )
  let removed = 0
  const walk = async (dir) => {
    let entries = []
    try {
      entries = await readdir(join(out, dir), { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const path = dir ? `${dir}/${entry.name}` : entry.name
      if (!dir && entry.isDirectory() && entry.name !== manifest.version) {
        // Only folders a bake writes: a renderer version's.
        if (!/^([0-9a-f]{10}|dev)$/.test(entry.name)) continue
        await rm(join(out, path), { recursive: true, force: true })
        say(`Removed ${relative(ROOT, join(out, path))}: baked by renderer ${entry.name}.`)
      } else if (entry.isDirectory()) await walk(path)
      else if (dir && entry.name.endsWith('.webp') && !kept.has(path)) {
        await rm(join(out, path), { force: true })
        removed++
      }
    }
  }
  await walk('')
  if (removed) say(`Removed ${removed} images a later bake replaced.`)
}

main().catch((error) => {
  console.error(error instanceof Refusal ? error.message : error)
  process.exitCode = 1
})

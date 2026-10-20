/**
 * What the page-driving scripts share (scripts/look-match.mjs, scripts/contact-sheet.mjs,
 * scripts/stage-check.mjs): the built app served by Vite's preview server, headless Chromium on
 * SwiftShader, the app's own TypeScript (designs, angles) loaded through Vite, and image
 * statistics computed in the page, so no image library is needed.
 *
 * Headless Chromium in a container cannot present WebGPU to a canvas (the device is lost), so the
 * raster runs on three's WebGL2 backend over ANGLE/SwiftShader, as scripts/bake-stills.mjs does.
 */
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

export const ROOT = fileURLToPath(new URL('..', import.meta.url))
/** The chromium this environment ships, when Playwright has none of its own. */
const CHROMIUM = '/opt/pw-browsers/chromium-1194/chrome-linux/chrome'

export const sleep = (ms) => new Promise((done) => setTimeout(done, ms))

export function loadPlaywright() {
  const require = createRequire(import.meta.url)
  for (const id of ['/opt/node22/lib/node_modules/playwright', 'playwright']) {
    try {
      return require(id)
    } catch {
      // Try the next.
    }
  }
  throw new Error(
    'These checks drive headless Chromium with Playwright: npm install --no-save playwright && npx playwright install chromium, then run again.',
  )
}

/** `npm run build`, unless told to use dist/ as it is. */
export function build(enabled = true) {
  if (!enabled) return
  const result = spawnSync('npm', ['run', 'build'], { cwd: ROOT, stdio: 'inherit' })
  if (result.status !== 0) throw new Error('npm run build failed')
}

/** The app's own modules (config, gallery angles), in TypeScript, through Vite. */
export async function loadApp() {
  const { createServer } = await import('vite')
  const vite = await createServer({
    root: ROOT,
    logLevel: 'error',
    server: { middlewareMode: true, hmr: false },
    // Modules loaded server-side only: no browser dependencies to pre-bundle.
    optimizeDeps: { noDiscovery: true, entries: [] },
    appType: 'custom',
  })
  try {
    const config = await vite.ssrLoadModule('/src/lib/config.ts')
    const gallery = await vite.ssrLoadModule('/src/render/gallery.ts')
    return { config, gallery }
  } finally {
    await vite.close()
  }
}

/**
 * Serves the app and opens headless Chromium on it: `{ base, browser, close }`. The built app in
 * dist/, or with `dev` the dev server, whose page can import the app's modules (`await
 * import('/src/render/…')`) to try a change without a build.
 */
export async function launch({ port = 4192, dev = false } = {}) {
  const { chromium } = loadPlaywright()
  const vite = await import('vite')
  const server = dev
    ? await vite.createServer({
        root: ROOT,
        logLevel: 'warn',
        server: { host: '127.0.0.1', port, strictPort: false, hmr: false },
      })
    : await vite.preview({
        root: ROOT,
        logLevel: 'warn',
        preview: { host: '127.0.0.1', port, strictPort: false, open: false },
      })
  if (dev) await server.listen()
  const base = server.resolvedUrls.local[0].replace(/\/$/, '')
  const browser = await chromium.launch({
    executablePath: process.env.CHROMIUM_PATH ?? (existsSync(CHROMIUM) ? CHROMIUM : undefined),
    args: [
      '--use-gl=angle',
      '--use-angle=swiftshader',
      '--enable-unsafe-swiftshader',
      '--ignore-gpu-blocklist',
      ...(process.getuid?.() === 0 ? ['--no-sandbox'] : []),
    ],
  })
  return {
    base,
    browser,
    async close() {
      await browser.close()
      await server.close()
    },
  }
}

/** Hides what the stage draws over its picture (toolbar, labels, status), for screenshots. */
export const BARE_STAGE = `.still-stage > :not(.scene-layer):not(.still-layers):not(.live-freeze),
  .still-loading { visibility: hidden !important; }`

/** The stage's box on the page, for screenshots of the picture alone. */
export async function stageBox(page) {
  return page.evaluate(() => {
    const box = document.querySelector('.still-stage').getBoundingClientRect()
    return {
      x: Math.round(box.x),
      y: Math.round(box.y),
      width: Math.round(box.width),
      height: Math.round(box.height),
    }
  })
}

/**
 * Sizes the viewport so the stage is `width` pixels across: the stage keeps its shape (16:10 or
 * 4:5) inside the frame the layout gives it, and the frame grows with the viewport less what is
 * round it (the header, the panel, the filmstrip), measured and taken off.
 */
export async function fitStage(page, width, ratio) {
  const height = Math.round(width / ratio)
  for (let i = 0; i < 4; i++) {
    await sleep(500)
    const box = await stageBox(page)
    if (Math.abs(box.width - width) <= 1 && Math.abs(box.height - height) <= 1) return box
    const viewport = page.viewportSize()
    const frame = await page.evaluate(() => {
      const rect = document.querySelector('.stage-frame').getBoundingClientRect()
      return { width: rect.width, height: rect.height }
    })
    // A frame exactly the stage's size, plus a pixel each way so rounding never shrinks it.
    await page.setViewportSize({
      width: Math.max(320, Math.round(viewport.width - frame.width + width + 1)),
      height: Math.max(320, Math.round(viewport.height - frame.height + height + 1)),
    })
  }
  return stageBox(page)
}

/** A PNG screenshot of the stage's picture, overlays hidden. */
export async function shootStage(page) {
  const clip = await stageBox(page)
  return page.screenshot({ clip, type: 'png' })
}

/**
 * Installed in every page (`page.addInitScript(pageStats)`): `window.__stats(a, b)` compares two
 * images (base64 PNGs), `window.__diff(a, b)` gives how far apart two frames are.
 */
export function pageStats() {
  const decode = async (base64) => {
    const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0))
    const bitmap = await createImageBitmap(new Blob([bytes], { type: 'image/png' }))
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height)
    const context = canvas.getContext('2d', { willReadFrequently: true })
    context.drawImage(bitmap, 0, 0)
    const { data } = context.getImageData(0, 0, bitmap.width, bitmap.height)
    bitmap.close()
    return { data, width: canvas.width, height: canvas.height }
  }
  const linear = new Float32Array(256)
  for (let i = 0; i < 256; i++) {
    const c = i / 255
    linear[i] = c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
  }
  /** Luminance below this (linear) counts as black: a log of 0 would swamp the mean. */
  const FLOOR = 1 / 1024
  window.__diff = async (a, b) => {
    const [x, y] = await Promise.all([decode(a), decode(b)])
    if (x.width !== y.width || x.height !== y.height) return 1
    let sum = 0
    for (let i = 0; i < x.data.length; i += 4)
      sum +=
        Math.abs(x.data[i] - y.data[i]) +
        Math.abs(x.data[i + 1] - y.data[i + 1]) +
        Math.abs(x.data[i + 2] - y.data[i + 2])
    return sum / ((x.data.length / 4) * 3 * 255)
  }
  /**
   * How `live` differs from `still`: the mean log₂ luminance (stops), the same over the still's
   * darker half (shade), each channel's ratio relative to green (white balance), and SSIM of luma.
   */
  window.__stats = async (still, live) => {
    const [s, l] = await Promise.all([decode(still), decode(live)])
    if (s.width !== l.width || s.height !== l.height)
      throw new Error(`sizes differ: ${s.width}×${s.height} and ${l.width}×${l.height}`)
    const n = s.width * s.height
    const ys = new Float32Array(n)
    const yl = new Float32Array(n)
    const sums = { s: [0, 0, 0], l: [0, 0, 0] }
    for (let p = 0, i = 0; p < n; p++, i += 4) {
      const sr = linear[s.data[i]],
        sg = linear[s.data[i + 1]],
        sb = linear[s.data[i + 2]]
      const lr = linear[l.data[i]],
        lg = linear[l.data[i + 1]],
        lb = linear[l.data[i + 2]]
      sums.s[0] += sr
      sums.s[1] += sg
      sums.s[2] += sb
      sums.l[0] += lr
      sums.l[1] += lg
      sums.l[2] += lb
      ys[p] = 0.2126 * sr + 0.7152 * sg + 0.0722 * sb
      yl[p] = 0.2126 * lr + 0.7152 * lg + 0.0722 * lb
    }
    const median = Float32Array.from(ys).sort()[n >> 1]
    let all = 0,
      shade = 0,
      shaded = 0
    for (let p = 0; p < n; p++) {
      const d = Math.log2(Math.max(yl[p], FLOOR)) - Math.log2(Math.max(ys[p], FLOOR))
      all += d
      if (ys[p] <= median) {
        shade += d
        shaded++
      }
    }
    const balance = (c) => sums.l[c] / sums.l[1] / (sums.s[c] / sums.s[1]) - 1
    // SSIM of gamma-encoded luma over 8×8 blocks.
    const luma = (data, p) =>
      (0.2126 * data[p * 4] + 0.7152 * data[p * 4 + 1] + 0.0722 * data[p * 4 + 2]) / 255
    const C1 = 0.01 ** 2,
      C2 = 0.03 ** 2
    let ssim = 0,
      blocks = 0
    for (let by = 0; by + 8 <= s.height; by += 8)
      for (let bx = 0; bx + 8 <= s.width; bx += 8) {
        let ma = 0,
          mb = 0,
          va = 0,
          vb = 0,
          cov = 0
        for (let y = by; y < by + 8; y++)
          for (let x = bx; x < bx + 8; x++) {
            const p = y * s.width + x
            ma += luma(s.data, p)
            mb += luma(l.data, p)
          }
        ma /= 64
        mb /= 64
        for (let y = by; y < by + 8; y++)
          for (let x = bx; x < bx + 8; x++) {
            const p = y * s.width + x
            const a = luma(s.data, p) - ma,
              b = luma(l.data, p) - mb
            va += a * a
            vb += b * b
            cov += a * b
          }
        va /= 63
        vb /= 63
        cov /= 63
        ssim += ((2 * ma * mb + C1) * (2 * cov + C2)) / ((ma * ma + mb * mb + C1) * (va + vb + C2))
        blocks++
      }
    return {
      stops: all / n,
      shade: shade / shaded,
      red: balance(0),
      blue: balance(2),
      ssim: ssim / blocks,
      width: s.width,
      height: s.height,
    }
  }
}

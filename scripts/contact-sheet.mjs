#!/usr/bin/env node
/**
 * Contact sheets of the gallery's framings: for each design and setting, the stage at each angle
 * as the live raster draws it posed at that angle's camera (no stills: `?cloud=0`, Lite unless
 * told otherwise), tiled into one PNG per design and setting with each frame labelled. For
 * reviewing the camera search (src/render/gallery.ts) across builds and settings, and the
 * room's lights.
 *
 *   node scripts/contact-sheet.mjs [options]
 *
 * Options:
 *   --designs <list>      default, strength40, container, slatted, timber, recovery, movement,
 *                         cardio, or a signature build's id (default: default,strength40,container,
 *                         slatted and every signature build)
 *   --environments <list> settings (default: every one)
 *   --angles <list>       angle ids (default: entry,centre,back)
 *   --quality <tier>      lite | high | ultra (default lite)
 *   --aspect <shape>      wide | tall (default wide)
 *   --out <dir>           where the sheets go (default contact-sheets/ in the system's temporary
 *                         directory)
 *   --no-build            use dist/ as it is
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { BARE_STAGE, build, launch, loadApp, shootStage, sleep } from './harness.mjs'

const { values: options } = parseArgs({
  allowNegative: true,
  options: {
    designs: { type: 'string' },
    environments: { type: 'string' },
    angles: { type: 'string', default: 'entry,centre,back' },
    quality: { type: 'string', default: 'lite' },
    aspect: { type: 'string', default: 'wide' },
    out: { type: 'string', default: join(tmpdir(), 'contact-sheets') },
    build: { type: 'boolean', default: true },
    help: { type: 'boolean', short: 'h', default: false },
  },
})

/** The designs a sheet can show, by name. */
function designs(lib) {
  const base = lib.DEFAULT_CONFIG
  const named = {
    default: base,
    strength40: { ...base, length: 40, items: lib.packageItems('strength', 40) },
    container: { ...base, family: 'container' },
    slatted: { ...base, interiorStyle: 'slatted' },
    timber: { ...base, interiorStyle: 'timber' },
    recovery: { ...base, package: 'recovery', items: lib.packageItems('recovery', 20) },
    movement: { ...base, package: 'movement', items: lib.packageItems('movement', 20) },
    cardio: { ...base, package: 'cardio', items: lib.packageItems('cardio', 20) },
  }
  for (const s of lib.SIGNATURES) named[s.id] = s.config
  return named
}

/** Frames are settled when two screenshots a second and a half apart match. */
async function settled(page) {
  let last = await shootStage(page)
  for (let i = 0; i < 60; i++) {
    await sleep(1500)
    const next = await shootStage(page)
    if (next.equals(last)) return next
    last = next
  }
  return last
}

/** Tiles labelled frames (base64 PNGs) into one PNG, in the page. */
function tile({ frames, columns }) {
  return (async () => {
    const images = await Promise.all(
      frames.map(async ({ image }) => {
        const bytes = Uint8Array.from(atob(image), (c) => c.charCodeAt(0))
        return createImageBitmap(new Blob([bytes], { type: 'image/png' }))
      }),
    )
    const w = images[0].width,
      h = images[0].height,
      label = 22
    const rows = Math.ceil(images.length / columns)
    const canvas = new OffscreenCanvas(columns * (w + 8), rows * (h + label + 8))
    const g = canvas.getContext('2d')
    g.fillStyle = '#fff'
    g.fillRect(0, 0, canvas.width, canvas.height)
    images.forEach((image, i) => {
      const x = (i % columns) * (w + 8),
        y = Math.floor(i / columns) * (h + label + 8)
      g.fillStyle = '#111'
      g.font = '15px sans-serif'
      g.fillText(frames[i].label, x + 4, y + 16)
      g.drawImage(image, x, y + label)
    })
    const blob = await canvas.convertToBlob({ type: 'image/png' })
    const buffer = new Uint8Array(await blob.arrayBuffer())
    let binary = ''
    for (let i = 0; i < buffer.length; i += 0x8000)
      binary += String.fromCharCode(...buffer.subarray(i, i + 0x8000))
    return btoa(binary)
  })()
}

async function main() {
  if (options.help) {
    const source = await readFile(fileURLToPath(import.meta.url), 'utf8')
    console.log(/\/\*\*([\s\S]*?)\*\//.exec(source)[1].replace(/^ \* ?/gm, ''))
    return
  }
  const { config: lib, gallery } = await loadApp()
  const all = designs(lib)
  const names = options.designs
    ? options.designs.split(',')
    : ['default', 'strength40', 'container', 'slatted', ...lib.SIGNATURES.map((s) => s.id)]
  for (const name of names) if (!all[name]) throw new Error(`no design "${name}"`)
  const environments = options.environments
    ? options.environments.split(',')
    : lib.ENVIRONMENTS.map((e) => e.id)
  const ids = gallery.GALLERY_ANGLES.map((a) => a.id)
  const angles = options.angles.split(',')
  for (const angle of angles) if (!ids.includes(angle)) throw new Error(`no angle "${angle}"`)
  await mkdir(options.out, { recursive: true })
  build(options.build)
  const app = await launch({ port: 4193 })
  try {
    const page = await app.browser.newPage({
      viewport:
        options.aspect === 'tall' ? { width: 700, height: 1100 } : { width: 1400, height: 900 },
      deviceScaleFactor: 1,
    })
    page.on('pageerror', (error) => console.log(`  page error: ${error.message}`))
    for (const name of names)
      for (const environment of environments) {
        const config = { ...all[name], environment }
        await page.goto(
          `${app.base}/?quality=${options.quality}&cloud=0#c=${lib.encodeConfig(config)}`,
        )
        await page.addStyleTag({ content: BARE_STAGE })
        await page.waitForSelector('.film-tile', { timeout: 300_000 })
        const frames = []
        for (const angle of angles) {
          await page.locator('.film-tile').nth(ids.indexOf(angle)).click()
          await sleep(1000)
          const image = await settled(page)
          frames.push({
            label: `${name} · ${environment} · ${angle}`,
            image: image.toString('base64'),
          })
        }
        const sheet = await page.evaluate(tile, { frames, columns: Math.min(3, frames.length) })
        const file = join(options.out, `${name}-${environment}.png`)
        await writeFile(file, Buffer.from(sheet, 'base64'))
        console.log(file)
      }
  } finally {
    await app.close()
  }
}

main().catch((error) => {
  console.error(error.stack ?? error)
  process.exit(2)
})

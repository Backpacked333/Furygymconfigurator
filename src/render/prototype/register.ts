/** Private Node preparation loader. Never import this module from the application. */
import { registerHooks, stripTypeScriptTypes } from 'node:module'
import { readFileSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const root = new URL('../../../', import.meta.url)
const render = new URL('src/render/', root)
const materials = new URL('materials.ts', render).href
const equipment = new URL('equipment.ts', render).href
const capture = new URL('prototype/materialCapture.ts', render).href
const allowedMaterialImporters = new Set(
  ['architecture.ts', 'addons.ts', 'equipment.ts', 'palette.ts', 'openings.ts'].map(
    (path) => new URL(path, render).href,
  ),
)

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith('.') && context.parentURL?.startsWith(root.href)) {
      const url = new URL(specifier, context.parentURL)
      if (
        url.pathname.endsWith('.js') &&
        !existsSync(fileURLToPath(url)) &&
        existsSync(fileURLToPath(url.href.slice(0, -3) + '.ts'))
      )
        url.pathname = url.pathname.slice(0, -3) + '.ts'
      if (!/\.[a-z]+$/i.test(url.pathname) && existsSync(fileURLToPath(`${url.href}.ts`)))
        url.pathname += '.ts'
      if (url.href === materials) {
        if (!allowedMaterialImporters.has(context.parentURL))
          throw new Error('Unexpected browser material import in private preparation graph.')
        return { url: capture, shortCircuit: true }
      }
      if (url.pathname.endsWith('.ts')) return { url: url.href, shortCircuit: true }
    }
    return nextResolve(specifier, context)
  },
  load(url, context, nextLoad) {
    if (url.startsWith(root.href) && url.endsWith('.ts')) {
      let source = readFileSync(fileURLToPath(url), 'utf8')
      // Lexical, equipment-only boundary: no DOM globals, canvas pixels or browser emulation.
      // Keep every original geometry/placement operation; console pixels remain unsupported.
      if (url === equipment)
        source = `import { preparationDocument as document } from ${JSON.stringify(capture)};\n${source}`
      return {
        format: 'module',
        source: stripTypeScriptTypes(source, { mode: 'transform', sourceUrl: url }),
        shortCircuit: true,
      }
    }
    return nextLoad(url, context)
  },
})

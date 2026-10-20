/** CPU-only loader: only the authored building material import is added to the base allowlist. */
import '../src/render/prototype/register.ts'
import { registerHooks } from 'node:module'

const buildings = new URL('../src/render/buildings.ts', import.meta.url).href
const materials = new URL('../src/render/prototype/materialCapture.ts', import.meta.url).href
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (context.parentURL === buildings && specifier === './materials')
      return { url: materials, shortCircuit: true }
    return nextResolve(specifier, context)
  },
})

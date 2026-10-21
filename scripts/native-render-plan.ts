/** Offline only: no network, admission, queue mutation, or render invocation. */
import { readFileSync } from 'node:fs'
import { planBulkRenders } from '../src/render-library/bulkPlan'

const [targetsPath, savedKeysPath] = process.argv.slice(2)
if (!targetsPath || !savedKeysPath)
  throw new Error('Usage: native-render-plan.ts designs.json saved-image-keys.json')
const designs = JSON.parse(readFileSync(targetsPath, 'utf8'))
const savedKeys = JSON.parse(readFileSync(savedKeysPath, 'utf8'))
if (!Array.isArray(designs) || !Array.isArray(savedKeys))
  throw new Error('Expected two JSON arrays.')
console.log(JSON.stringify(await planBulkRenders(designs, savedKeys), null, 2))

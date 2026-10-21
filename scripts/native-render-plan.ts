/** Offline only: no network, admission, queue mutation, or render invocation. */
import { readFileSync } from 'node:fs'
import { planBulkRenders } from '../src/render-library/bulkPlan'

const [targetsPath, savedKeysPath, savedImagesPath] = process.argv.slice(2)
if (!targetsPath || !savedKeysPath || !savedImagesPath)
  throw new Error(
    'Usage: native-render-plan.ts designs.json saved-image-keys.json saved-images.json',
  )
const designs = JSON.parse(readFileSync(targetsPath, 'utf8'))
const savedKeys = JSON.parse(readFileSync(savedKeysPath, 'utf8'))
const savedImages = JSON.parse(readFileSync(savedImagesPath, 'utf8'))
if (!Array.isArray(designs) || !Array.isArray(savedKeys) || !Array.isArray(savedImages))
  throw new Error('Expected three JSON arrays.')
console.log(JSON.stringify(await planBulkRenders(designs, savedKeys, savedImages), null, 2))

import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import {
  writePrototypeReviewManifests,
  validatePrototypeReviewDirectory,
} from '../src/render/prototype/writeManifests'

export async function runPrototypeFixtures(args: readonly string[]) {
  if (
    args.length !== 2 ||
    !['--out', '--verify'].includes(args[0]) ||
    !args[1] ||
    args[1].startsWith('--')
  )
    throw new Error(
      'Usage: NODE_ENV=production node --import ./src/render/prototype/register.ts ./scripts/prototype-fixtures.ts (--out <NEW-directory> | --verify <existing-directory>)',
    )
  return args[0] === '--verify'
    ? validatePrototypeReviewDirectory(resolve(args[1]))
    : writePrototypeReviewManifests(resolve(args[1]))
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    console.log(JSON.stringify(await runPrototypeFixtures(process.argv.slice(2)), null, 2))
  } catch (error) {
    console.error(error instanceof Error ? error.message : 'Prototype preparation failed.')
    process.exitCode = 1
  }
}

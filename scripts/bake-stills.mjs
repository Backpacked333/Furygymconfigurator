#!/usr/bin/env node
/** Retired raw-scene bake entry point: no proxy, renderer, storage or manifest mutation. */
const message =
  'LEGACY_RENDER_DISABLED: legacy baking is retired. Use a qualified private P04 worker after separate execution approval. Existing images and manifests are unchanged.'
if (process.argv.length === 3 && ['--help', '-h'].includes(process.argv[2])) {
  console.log(message)
} else {
  console.error(message)
  process.exitCode = 1
}

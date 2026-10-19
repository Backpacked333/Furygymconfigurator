/** Explicit source/build verification only. No permit issuer, browser startup or render call. */
import { registerHooks, stripTypeScriptTypes } from 'node:module'
import { existsSync, readFileSync } from 'node:fs'
import { open, realpath } from 'node:fs/promises'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const SOURCE = '/home/ubuntu/Documents/fury-display/'
const HANDOFF = '/home/ubuntu/Documents/fury-display-handoff'
export function parseRendererVerifyArgs(args: string[]) {
  if (
    args.length !== 3 ||
    args[0] !== '--verify-only' ||
    args[1] !== '--output' ||
    !new RegExp(`^${HANDOFF}/renderer-[A-Za-z0-9_-]+\\.json$`).test(args[2])
  )
    throw new Error('Use --verify-only --output <new renderer-*.json under fury-display-handoff>.')
  return args[2]
}
export async function verifyRenderer(output: string) {
  const { prepareDisplayBuild } = await import('../src/render/display/build.ts')
  const { displaySceneInput, displayCameraDigest } = await import('../src/render/display/input.ts')
  const { createSceneDesignFixtures } = await import('../src/domain/designFixtures.ts')
  const prepared = await prepareDisplayBuild()
  const fixtures = await Promise.all(
    createSceneDesignFixtures().map(async ({ id, design }) => ({
      id,
      plan: displaySceneInput(design),
      cameraDigest: await displayCameraDigest(design),
    })),
  )
  if (fixtures.length !== 6 || fixtures.some((f) => f.plan.profile.quality !== 'ultra'))
    throw new Error('Fixture/profile verification failed.')
  await prepared.revalidate()
  if ((await realpath(dirname(output))) !== HANDOFF)
    throw new Error('Output parent must be real handoff.')
  const report = {
    state: 'private-display-build-verified-no-render',
    renderCalls: 0,
    browserStarts: 0,
    qualified: false,
    sourceRoot: SOURCE,
    build: prepared.build,
    fixtures,
    manifests: prepared.manifests,
    untested: [
      'GPU execution',
      'visual quality',
      'warm resource stability',
      'owned host teardown',
      'end-to-end latency',
    ],
    holds: [
      'renderer not selected',
      'rights',
      'fonts',
      'art direction',
      'engineering',
      'paid/production denied',
    ],
  }
  const file = await open(output, 'wx', 0o600)
  try {
    await file.writeFile(`${JSON.stringify(report, null, 2)}\n`)
    await file.sync()
  } finally {
    await file.close()
  }
  return report
}
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const root = new URL(`file://${SOURCE}`)
  registerHooks({
    resolve(specifier, context, nextResolve) {
      if (specifier.startsWith('.') && context.parentURL?.startsWith(root.href)) {
        const url = new URL(specifier, context.parentURL)
        if (!/\.[a-z]+$/i.test(url.pathname) && existsSync(fileURLToPath(`${url.href}.ts`)))
          url.pathname += '.ts'
        if (url.pathname.endsWith('.ts')) return { url: url.href, shortCircuit: true }
      }
      return nextResolve(specifier, context)
    },
    load(url, context, nextLoad) {
      if (url.startsWith(root.href) && url.endsWith('.ts'))
        return {
          format: 'module',
          source: stripTypeScriptTypes(readFileSync(fileURLToPath(url), 'utf8'), {
            mode: 'transform',
            sourceUrl: url,
          }),
          shortCircuit: true,
        }
      return nextLoad(url, context)
    },
  })
  const output = parseRendererVerifyArgs(process.argv.slice(2))
  const report = await verifyRenderer(output)
  console.log(
    JSON.stringify({
      state: report.state,
      output,
      renderCalls: 0,
      browserStarts: 0,
      qualified: false,
      build: report.build,
    }),
  )
}

/** Offline preparation only. No approval issuer, provider client, browser or render invocation. */
import { registerHooks, stripTypeScriptTypes } from 'node:module'
import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

export function parseCloudWorkerVerifyArgs(args: string[]) {
  if (args.length !== 1 || args[0] !== '--verify-only')
    throw new Error('Only --verify-only is supported. Execution is denied.')
}
export async function verifyCloudWorker() {
  const { preparePortablePackage, verifyPortableFiles } =
    await import('../src/image-service/remote-display/worker/package.ts')
  const { defaultDesign } = await import('../src/domain/design.ts')
  const { bindCloudRecipe } = await import('../src/display/cloudContract.ts')
  const { displayCameraDigest } = await import('../src/render/display/input.ts')
  const { createRemoteDisplayBackend } =
    await import('../src/image-service/remote-display/worker/backend.ts')
  const pkg = await preparePortablePackage()
  verifyPortableFiles(pkg.files(), pkg.packageDigest)
  const design = defaultDesign()
  const recipe = await bindCloudRecipe(
    design,
    pkg.build,
    pkg.packageDigest,
    await displayCameraDigest(design),
  )
  const backend = createRemoteDisplayBackend()
  let denied = false
  try {
    await backend.open({ paidExecutionAllowed: true })
  } catch {
    denied = true
  }
  await backend.close()
  if (!denied) throw new Error('Cloud build hold failed.')
  await pkg.revalidate()
  return {
    kind: 'cloud-display-worker-offline-verification@1',
    dispatchAllowed: false,
    providerCalls: 0,
    browserStarts: 0,
    renderCalls: 0,
    packageDigest: pkg.packageDigest,
    records: pkg.records,
    sourceBytes: pkg.records.reduce((sum, record) => sum + record.bytes, 0),
    build: pkg.build,
    recipe,
    runtimeImageConfigured: false,
    runtimeObserved: false,
    gpuObserved: false,
    terminationObserved: false,
    billingFinalObserved: false,
    qualified: false,
    holds: [
      'SDK public runtime API incompatible',
      'runtime image/SDK wheel/font bytes unpinned',
      'non-root safe WebGPU unproven',
      'signed capped launch approval absent',
      'independent termination and final billing unobserved',
      'visual/rights/font/engineering review outstanding',
    ],
  }
}
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  parseCloudWorkerVerifyArgs(process.argv.slice(2))
  const root = new URL('../', import.meta.url)
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
  verifyCloudWorker()
    .then((report) => console.log(JSON.stringify(report)))
    .catch(() => {
      console.error('Cloud worker offline verification failed. Execution remains denied.')
      process.exitCode = 1
    })
}

import { readFile } from 'node:fs/promises'
import { existsSync, readFileSync } from 'node:fs'
import { registerHooks, stripTypeScriptTypes } from 'node:module'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

export function parseCloudServiceVerifyArgs(args: string[]) {
  if (args.length !== 1 || args[0] !== '--verify-only')
    throw new Error('Only --verify-only is supported. Execution remains denied.')
}

/** Source-only integration verifier. No environment/credential loading, worker import, provider or pixels. */
export async function verifyCloudServiceSource(root: string) {
  const { CLOUD_DISPLAY_BUILD_GATE, CLOUD_DISPLAY_PROTOCOL } =
    await import('../src/display/cloudContract.ts')
  const { isPrivateDisplayPath } = await import('./display-private-boundary.ts')
  const plugin = await readFile(join(root, 'scripts/cloud-display-service-plugin.ts'), 'utf8')
  const service = await readFile(
    join(root, 'src/image-service/remote-display/service/service.ts'),
    'utf8',
  )
  const cache = await readFile(
    join(root, 'src/image-service/remote-display/service/cache.ts'),
    'utf8',
  )
  const checks = {
    dispatchHeld: CLOUD_DISPLAY_BUILD_GATE.dispatchAllowed === false,
    productionHeld: CLOUD_DISPLAY_BUILD_GATE.productionAllowed === false,
    workerFactory:
      plugin.includes("import('../src/image-service/remote-display/worker/backend')") &&
      plugin.includes('createRemoteDisplayBackend()'),
    gatedMissAndExecution:
      (service.match(/!CLOUD_DISPLAY_BUILD_GATE\.dispatchAllowed/g) ?? []).length >= 3,
    nestedPixelVerifier: cache.includes('verifyDisplayPixels(job, receipt.image, png)'),
    distinctOuterProvenance: cache.includes("kind: 'external-private-three-display'"),
    noLocalCacheOrRun: !/\b(?:DisplayCache|DisplayRun|displayArtifact)\s*\(/.test(
      `${cache}\n${service}`,
    ),
    privateNamespace: [
      'src/image-service/remote-display/worker/backend.ts',
      'src/image-service/remote-display/service/service.ts',
      'src/display/cloudSession.ts',
      'scripts/cloud-display-service-plugin.ts',
    ].every((path) => isPrivateDisplayPath(`/${path}`)),
    browserContractPreserved: !isPrivateDisplayPath('/src/display/cloudContract.ts'),
  }
  if (Object.values(checks).some((value) => !value))
    throw new Error('Cloud source boundary verification failed.')
  return {
    protocol: CLOUD_DISPLAY_PROTOCOL,
    checks,
    providerCalls: 0,
    renderedImages: 0,
    executionAuthorized: false as const,
    observedRuntime: 'unobserved' as const,
    observedProviderTermination: 'unobserved' as const,
    observedBillingFinal: 'unobserved' as const,
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  parseCloudServiceVerifyArgs(process.argv.slice(2))
  const root = new URL('../', import.meta.url)
  // Resolve only this source tree's TS modules; never load a provider or operator configuration.
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
  verifyCloudServiceSource(fileURLToPath(root))
    .then((report) => console.log(JSON.stringify(report)))
    .catch(() => {
      console.error('Cloud source verification failed; execution remains denied.')
      process.exitCode = 1
    })
}

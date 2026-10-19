/** Private local CLI only. No CPU preparation loader, app runtime, server API or customer imports. */
import { registerHooks, stripTypeScriptTypes } from 'node:module'
import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const root = new URL('../', import.meta.url)
// Resolution/transformation only. Unlike prototype/register.ts, never redirect materials or stub DOM.
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

const cancellation = new AbortController()
const cancel = () => cancellation.abort()
process.once('SIGINT', cancel)
process.once('SIGTERM', cancel)
try {
  const { HISTORY_DIRECTORY, parseCaptureCli, runCapture } =
    await import('../src/render/prototype/capture/runner.ts')
  const args = process.argv.slice(2)
  if (args.length === 1 && args[0] === '--check') {
    // Read-only in-memory closure check. Never opens history, output, HTTP, CDP or a renderer.
    const { SOURCE_ROOT, prepareCaptureBuild } =
      await import('../src/render/prototype/capture/host.ts')
    const { CAPTURE_LIMITS, assertCaptureActive } =
      await import('../src/render/prototype/capture/contract.ts')
    const deadline = performance.now() + CAPTURE_LIMITS.jobMs
    const fence = () => assertCaptureActive(cancellation.signal, performance.now(), deadline)
    const prepared = await prepareCaptureBuild(fence)
    await prepared.revalidate()
    fence()
    console.log(
      JSON.stringify({
        state: 'build-verified-no-render',
        sourceRoot: SOURCE_ROOT,
        historyDirectory: HISTORY_DIRECTORY,
        build: prepared.build,
        records: Object.fromEntries(
          Object.entries(prepared.manifests).map(([kind, records]) => [kind, records.length]),
        ),
      }),
    )
  } else {
    const result = await runCapture(parseCaptureCli(args), cancellation.signal)
    // Bounded protocol summary only, never raw browser/source/environment errors.
    console.log(
      JSON.stringify({ state: result.state, ...('code' in result ? { code: result.code } : {}) }),
    )
    process.exitCode = result.state === 'complete' ? 0 : 1
  }
} catch {
  console.error(
    'Private local capture failed. Preserve partial output/history; inspect receipts before retrying.',
  )
  process.exitCode = 1
} finally {
  process.removeListener('SIGINT', cancel)
  process.removeListener('SIGTERM', cancel)
}

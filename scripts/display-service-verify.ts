/** Source/build-only verifier. There is deliberately no execution mode in this CLI. */
import { registerHooks, stripTypeScriptTypes } from 'node:module'
import { existsSync, readFileSync, writeFileSync, realpathSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

export async function verifyDisplayService() {
  const [
    { createProductionDisplayService },
    { createDisplayRequest, bindDisplay, DISPLAY_PROFILES },
    { defaultDesign },
  ] = await Promise.all([
    import('../src/image-service/display/production'),
    import('../src/display/contract'),
    import('../src/domain/design'),
  ])
  const connection = await createProductionDisplayService(undefined, true)
  try {
    const build = await connection.service.prepare()
    const design = defaultDesign()
    const binding = await bindDisplay(design, build)
    let denial: string | null = null
    try {
      await connection.service.submit(
        'verify_only_owner_no_permission',
        createDisplayRequest(design),
      )
    } catch (error) {
      const { DisplayServiceError } = await import('../src/image-service/display/errors')
      if (error instanceof DisplayServiceError) denial = error.wire.code
      else throw error
    }
    if (denial !== 'execution-denied')
      throw new Error('Verify-only default denial did not hold; no permit may be created.')
    return {
      state: 'private-display-service-prepared-no-render',
      build,
      binding,
      profiles: DISPLAY_PROFILES,
      defaultMiss: denial,
      renderCalls: 0,
      browserStarts: 0,
      permitCreated: false,
      qualified: false,
      paidExecutionAllowed: false,
      productionAllowed: false,
      visualQualityTested: false,
      latencyTested: false,
      hostShutdownProven: false,
      billingFinal: false,
    }
  } finally {
    await connection.service.close()
  }
}

export function parseDisplayServiceVerifyArgs(args: string[]) {
  if (
    args[0] !== '--verify-only' ||
    (args.length !== 1 && !(args.length === 3 && args[1] === '--output'))
  )
    throw new Error('Only --verify-only [--output NEW_JSON_UNDER_HANDOFF] is supported.')
  const output = args[2]
  if (
    output &&
    (resolve(output) !== output ||
      dirname(output) !== '/home/ubuntu/Documents/fury-display-handoff' ||
      !/\/service-verify-[A-Za-z0-9_-]+\.json$/.test(output) ||
      existsSync(output) ||
      realpathSync(dirname(output)) !== dirname(output))
  )
    throw new Error('Verification output must be a new service-verify-*.json under the handoff.')
  return output
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const root = new URL('../', import.meta.url)
  // Local TS resolution only, no browser/CPU material stubs or arbitrary transpilation plugin.
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
  try {
    const output = parseDisplayServiceVerifyArgs(process.argv.slice(2))
    const result = await verifyDisplayService()
    const bytes = `${JSON.stringify(result, null, 2)}\n`
    if (output) writeFileSync(output, bytes, { flag: 'wx', mode: 0o600 })
    console.log(bytes)
  } catch (error) {
    console.error(
      'Private display service verify-only failed; no render or permit was requested.',
      error instanceof Error ? error.message : '',
    )
    process.exitCode = 1
  }
}

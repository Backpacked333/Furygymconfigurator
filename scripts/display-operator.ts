/** Local operator entry. --preflight never opens/renders/creates permission. --serve is a
 * separately authorized future operation and still cannot dispatch until private admission. */
import { registerHooks, stripTypeScriptTypes } from 'node:module'
import { accessSync, constants, existsSync, readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { resolve } from 'node:path'

export function parseDisplayOperatorArgs(args: string[]) {
  if (args.length !== 1 || !['--preflight', '--serve'].includes(args[0]))
    throw new Error(
      'Use --preflight (read-only) or --serve (requires separate execution approval and existing provision). No permit issuer or reset command exists.',
    )
  return args[0]
}
export async function displayPreflight() {
  const { prepareDisplayBuild, DISPLAY_HANDOFF } = await import('../src/render/display/build')
  const { loadDisplayOperator } = await import('../src/display/operator')
  const prepared = await prepareDisplayBuild()
  const operator = loadDisplayOperator()
  const reasons: string[] = []
  if (!operator || operator.permit.expiresAt <= Date.now())
    reasons.push('No current operator-provisioned local permission.')
  const devices = ['/dev/dri', '/dev'].flatMap((directory) =>
    existsSync(directory)
      ? readdirSync(directory)
          .filter((name) =>
            directory === '/dev/dri' ? /^renderD\d+$/.test(name) : /^nvidia\d+$/.test(name),
          )
          .map((name) => `${directory}/${name}`)
      : [],
  )
  const accessible = devices.filter((path) => {
    try {
      accessSync(path, constants.R_OK | constants.W_OK)
      return true
    } catch {
      return false
    }
  })
  if (!accessible.length)
    reasons.push('No accessible GPU device node; software/fallback execution is denied.')
  if (existsSync(`${DISPLAY_HANDOFF}/renderer-runs/owned.lock`))
    reasons.push('Renderer ownership lock exists; external reconciliation required, never reset.')
  if (operator && existsSync(`${DISPLAY_HANDOFF}/renderer-runs/${operator.permit.runId}`))
    reasons.push('This renderer run ID has already been used; cannot reset or adopt it.')
  const service = `${DISPLAY_HANDOFF}/private-display-service`
  if (existsSync(service) && readdirSync(service).some((name) => name !== 'objects'))
    reasons.push('Service run journal exists; inspect without deleting or replacing it.')
  await prepared.revalidate()
  return {
    state: 'private-display-operator-preflight',
    build: prepared.build,
    executionPreflightPassed: reasons.length === 0,
    reasons,
    gpuDeviceNodesAccessible: accessible.length,
    hardwareRuntimeObserved: false,
    browserStarts: 0,
    renderCalls: 0,
    permitCreated: false,
    qualified: false,
    productionAllowed: false,
    paidExecutionAllowed: false,
    hostShutdownProven: false,
    billingFinal: false,
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
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
  try {
    const mode = parseDisplayOperatorArgs(process.argv.slice(2))
    const preflight = await displayPreflight()
    console.log(JSON.stringify(preflight, null, 2))
    if (mode === '--serve') {
      if (!preflight.executionPreflightPassed)
        throw new Error('Execution preflight denied; nothing started.')
      process.env.FURY_IMAGE_PROTOTYPE = '1'
      process.env.FURY_PRIVATE_DISPLAY = '1'
      if (process.env.NODE_ENV === 'production') throw new Error('Production execution denied.')
      const { createServer } = await import('vite')
      const server = await createServer({
        root: fileURLToPath(root),
        mode: 'development',
        server: {
          host: '127.0.0.1',
          port: 5173,
          strictPort: true,
          allowedHosts: ['127.0.0.1', 'localhost'],
        },
      })
      await server.listen()
      server.printUrls()
      console.log(
        'Unqualified local candidate only. Authenticate the existing owner before selecting private-display. No renderer starts until an admitted miss.',
      )
      let closing = false
      const close = () => {
        if (!closing) {
          closing = true
          void server.close().catch(() => {
            process.exitCode = 1
          })
        }
      }
      process.once('SIGINT', close)
      process.once('SIGTERM', close)
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : 'Display operator command denied.')
    process.exitCode = 1
  }
}

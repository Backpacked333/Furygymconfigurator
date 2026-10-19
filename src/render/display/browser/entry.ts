import { displayBuildSchema, displayIdSchema } from '../../../display/contract'
import { createDisplayScene } from './scene'

/** Only the token-private host serves this bootstrap; ordinary app routes never import it. */
async function bootstrap() {
  const response = await fetch('/bootstrap.json', {
    redirect: 'error',
    credentials: 'omit',
    cache: 'no-store',
  })
  if (
    response.status !== 200 ||
    response.redirected ||
    response.headers.get('content-type') !== 'application/json'
  )
    throw new Error('Private bootstrap denied.')
  const text = await response.text()
  if (text.length > 16384) throw new Error('Private bootstrap bound.')
  const value = JSON.parse(text) as { build?: unknown; sessionId?: unknown }
  if (Object.keys(value).sort().join() !== 'build,sessionId') throw new Error('Invalid bootstrap.')
  const build = displayBuildSchema.parse(value.build),
    sessionId = displayIdSchema.parse(value.sessionId)
  let scene: Awaited<ReturnType<typeof createDisplayScene>> | undefined
  let opening: Promise<Awaited<ReturnType<typeof createDisplayScene>>> | undefined
  const get = () =>
    (opening ??= createDisplayScene(build, sessionId).then((value) => (scene = value)))
  Object.defineProperty(globalThis, '__FURY_PRIVATE_DISPLAY__', {
    configurable: false,
    writable: false,
    value: Object.freeze({
      ready: async () => ({ build, sessionId, runtime: (await get()).runtime }),
      render: async (job: unknown) => (await get()).render(job),
      dispose: async () => {
        await scene?.close()
      },
    }),
  })
}
void bootstrap()

import { createHash } from 'node:crypto'
import { chmodSync, lstatSync, mkdirSync, realpathSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import type { Plugin } from 'vite'
import {
  createMockImageMiddleware,
  unavailableMockImageMiddleware,
} from '../src/image-service/http'
import type { MockJobStore } from '../src/image-service/store'

export type PrototypeImagePluginOptions = {
  /** Trusted local configuration only. Must be outside the project root, never a request field. */
  stateDirectory?: string
}

function canonicalTarget(path: string): string {
  let existing = resolve(path)
  while (true) {
    try {
      lstatSync(existing)
      break
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || dirname(existing) === existing)
        throw error
      existing = dirname(existing)
    }
  }
  return join(realpathSync(existing), relative(existing, resolve(path)))
}

/** Opt-in dev adapter, lazily mounted by vite.config; no other product route is replaced. */
export function prototypeImagePlugin(options: PrototypeImagePluginOptions = {}): Plugin {
  let cleanup = () => {}
  return {
    name: 'fury-local-mock-image-prototype',
    apply: 'serve',
    async configureServer(server) {
      if (
        process.env.FURY_IMAGE_PROTOTYPE !== '1' ||
        process.env.NODE_ENV === 'production' ||
        server.config.command !== 'serve' ||
        server.config.mode === 'production' ||
        server.config.isProduction
      )
        return
      let store: MockJobStore | undefined
      try {
        // Keep node:sqlite out of the default/production path, including on older Node runtimes.
        const [{ MockJobStore }, { MockImageService }] = await Promise.all([
          import('../src/image-service/store'),
          import('../src/image-service/service'),
        ])
        const root = realpathSync(server.config.root)
        const scope = createHash('sha256').update(root).digest('hex').slice(0, 16)
        const directory =
          options.stateDirectory ??
          join(homedir(), '.local', 'state', 'fury-image-prototype', scope)
        const rel = relative(root, canonicalTarget(directory))
        if (
          !isAbsolute(directory) ||
          (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel))
        )
          throw new Error('Mock state must remain outside tracked source.')
        mkdirSync(directory, { recursive: true, mode: 0o700 })
        chmodSync(directory, 0o700)
        const stopFile = join(directory, 'STOP')
        const stopRequested = () => {
          if (process.env.FURY_IMAGE_PROTOTYPE_STOP === '1') return true
          try {
            statSync(stopFile)
            return true
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
            throw error
          }
        }
        store = new MockJobStore({ path: join(directory, 'mock-jobs.sqlite') })
        chmodSync(join(directory, 'mock-jobs.sqlite'), 0o600)
        const service = new MockImageService({ store, stopRequested })
        server.middlewares.use(
          createMockImageMiddleware({ service, principalSecret: store.principalSecret() }),
        )
        const timer = setInterval(() => {
          void service.runOnce().catch(() => {
            /* Disabled or unavailable: never dispatch unreserved work. */
          })
        }, 100)
        timer.unref()
        cleanup = () => {
          clearInterval(timer)
          service.close()
        }
        server.httpServer?.once('close', cleanup)
        server.config.logger.info(
          'Local mock diagnostic image API enabled; production/paid rendering remains denied.',
        )
      } catch {
        store?.close()
        // A missing SQLite runtime or denied/corrupt store does not enable a stateless budget bypass.
        server.middlewares.use(unavailableMockImageMiddleware())
        server.config.logger.warn(
          'Local mock image API unavailable; no fallback renderer or unreserved execution enabled.',
        )
      }
    },
    closeBundle() {
      cleanup()
    },
  }
}

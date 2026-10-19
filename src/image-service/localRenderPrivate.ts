// Node-only adapter. Never import from the image application or its public protocol.
import { existsSync, readFileSync, realpathSync } from 'node:fs'
import { registerHooks, stripTypeScriptTypes } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'
import type { PreparedCapture } from '../render/prototype/capture/host'
import type { LocalRenderSampleId } from './localRenderProtocol'
import { createPreparationHost } from './localRenderPreparation.ts'

export const LOCAL_RENDER_SOURCE_ROOT = '/home/ubuntu/Documents/fury-real'
export const LOCAL_RENDER_HANDOFF = '/home/ubuntu/Documents/fury-real-handoff'
export const LOCAL_RENDER_CACHE_DIRECTORY = `${LOCAL_RENDER_HANDOFF}/local-real-image-cache`
export const LOCAL_RENDER_HISTORY_DIRECTORY =
  '/home/ubuntu/Documents/fury-capture-handoff/local-three-capture-history'
export type LocalRenderPrepared = Pick<PreparedCapture, 'build' | 'manifests' | 'revalidate'>
export interface LocalRenderBackend {
  close?(): void
  prepare(fence: () => void): Promise<LocalRenderPrepared>
  capture(
    sampleId: LocalRenderSampleId,
    outputDirectory: string,
    signal: AbortSignal,
  ): Promise<unknown>
}

let hooked = false
/** Native file-URL imports deliberately bypass Vite config bundling (preserving import.meta.url).
 * Scoped resolver/transform only; no DOM/material stubs, child command, browser or attempt here. */
export function createLocalRenderBackend(root: string): LocalRenderBackend {
  if (root !== LOCAL_RENDER_SOURCE_ROOT || realpathSync(root) !== root)
    throw new Error('Unexpected local capture source root.')
  const rootUrl = pathToFileURL(`${root}/`).href
  if (!hooked) {
    registerHooks({
      resolve(specifier, context, nextResolve) {
        if (specifier.startsWith('.') && context.parentURL?.startsWith(rootUrl)) {
          const url = new URL(specifier, context.parentURL)
          if (!/\.[a-z]+$/i.test(url.pathname) && existsSync(fileURLToPath(`${url.href}.ts`)))
            url.pathname += '.ts'
          if (url.pathname.endsWith('.ts')) return { url: url.href, shortCircuit: true }
        }
        return nextResolve(specifier, context)
      },
      load(url, context, nextLoad) {
        if (url.startsWith(rootUrl) && url.endsWith('.ts'))
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
    hooked = true
  }
  // Variables + vite-ignore keep private modules out of the bundled config; only trusted literals.
  const hostUrl = `${rootUrl}src/render/prototype/capture/host.ts`
  const runnerUrl = `${rootUrl}src/render/prototype/capture/runner.ts`
  const contractUrl = `${rootUrl}src/render/prototype/capture/contract.ts`
  let preparation: ReturnType<typeof createPreparationHost> | undefined
  let closed = false
  return {
    async prepare(fence) {
      if (closed) throw new Error('Private metadata backend closed.')
      const { CAPTURE_LIMITS } = await import(/* @vite-ignore */ contractUrl)
      fence()
      if (closed) throw new Error('Private metadata backend closed.')
      preparation ??= createPreparationHost(
        root,
        `${rootUrl}src/image-service/localRenderPrivate.ts`,
        hostUrl,
        CAPTURE_LIMITS.jobMs,
      )
      return preparation.prepare(fence)
    },
    close() {
      closed = true
      preparation?.close()
    },
    async capture(sampleId, outputDirectory, signal) {
      const runner: typeof import('../render/prototype/capture/runner') = await import(
        /* @vite-ignore */ runnerUrl
      )
      if (runner.HISTORY_DIRECTORY !== LOCAL_RENDER_HISTORY_DIRECTORY)
        throw new Error('Retained capture history drifted; no admission allowed.')
      if (signal.aborted) throw new Error('Capture cancelled before admission.')
      return runner.runCapture({ sampleId, outputDirectory, kind: 'sample' }, signal)
    },
  }
}

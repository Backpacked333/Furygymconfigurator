// Node-only metadata worker. No browser, listener, capture admission or render invocation.
import { Worker } from 'node:worker_threads'
import type { LocalRenderPrepared } from './localRenderPrivate'

const bootstrap = `
const { parentPort, workerData } = require('node:worker_threads');
let prepared, generation = 0, busy = false, fence;
const ready = (async () => {
  const adapter = await import(workerData.adapterUrl);
  adapter.createLocalRenderBackend(workerData.root); // Native TypeScript resolution only.
  return import(workerData.hostUrl);
})();
parentPort.on('message', async message => {
  if (busy) return parentPort.postMessage({ ok: false, code: 'limit-exceeded' });
  busy = true;
  try {
    const deadline = performance.now() + workerData.deadlineMs;
    fence = () => {
      if (performance.now() >= deadline) throw Object.assign(new Error('Metadata deadline'), { code: 'timeout' });
    };
    const host = await ready;
    if (host.SOURCE_ROOT !== workerData.root) throw new Error('Unexpected source root');
    fence();
    if (message.operation === 'prepare') {
      prepared = undefined;
      prepared = await host.prepareCaptureBuild(() => fence());
      fence();
      generation++;
      parentPort.postMessage({ ok: true, value: { build: prepared.build, manifests: prepared.manifests, generation } });
    } else if (message.operation === 'revalidate') {
      if (!prepared || message.generation !== generation)
        throw Object.assign(new Error('Prepared closure replaced'), { code: 'identity-mismatch' });
      await prepared.revalidate();
      fence();
      parentPort.postMessage({ ok: true });
    } else throw new Error('Unknown metadata operation');
  } catch (error) {
    const code = ['identity-mismatch', 'limit-exceeded', 'timeout'].includes(error?.code) ? error.code : 'unavailable';
    parentPort.postMessage({ ok: false, code });
  } finally { busy = false; }
});
ready.catch(() => {});
`

type Snapshot = Omit<LocalRenderPrepared, 'revalidate'> & { generation: number }
type Reply = { ok: true; value?: Snapshot } | { ok: false; code: string }
const unavailable = () => new Error('Private metadata worker unavailable.')

export function createPreparationHost(
  root: string,
  adapterUrl: string,
  hostUrl: string,
  deadlineMs: number,
) {
  let worker: Worker | undefined
  let closed = false
  let pending: ((error?: unknown, reply?: Reply) => void) | undefined
  const terminate = () => {
    const owned = worker
    worker = undefined
    pending?.(unavailable())
    if (owned) void owned.terminate()
  }
  const call = (message: object, fence: () => void): Promise<Snapshot | undefined> => {
    fence()
    if (closed || pending) return Promise.reject(unavailable())
    if (!worker) {
      const owned = new Worker(bootstrap, {
        eval: true,
        execArgv: [],
        env: { NODE_ENV: 'production' },
        workerData: { root, adapterUrl, hostUrl, deadlineMs },
        resourceLimits: { maxOldGenerationSizeMb: 512 },
      })
      worker = owned
      owned.on('message', (reply: Reply) => {
        if (worker === owned) pending?.(undefined, reply)
      })
      owned.on('error', () => {
        if (worker === owned) terminate()
      })
      owned.on('exit', () => {
        if (worker === owned) terminate()
      })
    }
    const owned = worker
    owned.ref()
    return new Promise((resolve, reject) => {
      const deadline = performance.now() + deadlineMs
      const check = () => {
        try {
          fence()
          if (performance.now() >= deadline)
            throw Object.assign(new Error('Private metadata deadline.'), { code: 'timeout' })
        } catch (error) {
          pending?.(error)
          terminate()
        }
      }
      const timer = setInterval(check, 50)
      pending = (error, reply) => {
        clearInterval(timer)
        pending = undefined
        owned.unref()
        try {
          if (error) throw error
          fence()
          if (!reply?.ok) throw Object.assign(unavailable(), { code: reply?.code ?? 'unavailable' })
          resolve(reply.value)
        } catch (failure) {
          reject(failure)
        }
      }
      owned.postMessage(message)
    })
  }
  return {
    async prepare(fence: () => void): Promise<LocalRenderPrepared> {
      const snapshot = await call({ operation: 'prepare' }, fence)
      if (!snapshot) throw unavailable()
      return {
        build: snapshot.build,
        manifests: snapshot.manifests,
        revalidate: async () => {
          await call({ operation: 'revalidate', generation: snapshot.generation }, fence)
        },
      }
    },
    close() {
      closed = true
      terminate()
    },
  }
}

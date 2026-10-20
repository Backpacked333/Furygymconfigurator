import { constants, closeSync, fstatSync, lstatSync, openSync, readFileSync } from 'node:fs'
import { dirname, isAbsolute, normalize, parse } from 'node:path'
import { pathToFileURL } from 'node:url'
import {
  isSettledReceipt,
  policySchema,
  type Policy,
} from '../src/image-service/control-plane/contracts'
import { SqliteLedger } from '../src/image-service/control-plane/ledger'
import { FileObjectStore } from '../src/image-service/control-plane/objects'
import { LocalFakeProvider } from '../src/image-service/control-plane/provider'
import { IndependentWatchdog } from '../src/image-service/control-plane/watchdog'
import {
  providerCalls,
  providerCallTimeout,
} from '../src/image-service/control-plane/providerCalls'

export type WatchdogArguments = Readonly<{
  ledger: string
  provider: string
  objects?: string
  policy?: string
  kill?: string
}>

/** Strict private operator CLI. No init, reset, clear-kill, daemon, provider URL, execution or secret flags. */
export function parseWatchdogArguments(argv: readonly string[]): WatchdogArguments {
  const values = new Map<string, string>()
  let once = false
  for (let index = 0; index < argv.length; index++) {
    const flag = argv[index]
    if (flag === '--once') {
      if (once) throw new Error('invalid-operator-arguments')
      once = true
      continue
    }
    if (
      !['--ledger', '--provider', '--objects', '--policy', '--kill'].includes(flag) ||
      values.has(flag)
    )
      throw new Error('invalid-operator-arguments')
    const value = argv[++index]
    if (!value || value.startsWith('--')) throw new Error('invalid-operator-arguments')
    values.set(flag, value)
  }
  if (!once || !values.has('--ledger') || !values.has('--provider'))
    throw new Error('invalid-operator-arguments')
  for (const flag of ['--ledger', '--provider', '--objects', '--policy']) {
    const value = values.get(flag)
    if (
      value &&
      (!isAbsolute(value) || normalize(value) !== value || value === '/' || value.includes('\0'))
    )
      throw new Error('invalid-operator-path')
  }
  if (
    new Set([...values].filter(([flag]) => flag !== '--kill').map(([, value]) => value)).size !==
    [...values.keys()].filter((flag) => flag !== '--kill').length
  )
    throw new Error('overlapping-operator-paths')
  const kill = values.get('--kill')
  if (kill !== undefined && !/^[A-Za-z0-9][A-Za-z0-9 _.-]{0,119}$/.test(kill))
    throw new Error('invalid-kill-code')
  return {
    ledger: values.get('--ledger')!,
    provider: values.get('--provider')!,
    ...(values.has('--objects') ? { objects: values.get('--objects')! } : {}),
    ...(values.has('--policy') ? { policy: values.get('--policy')! } : {}),
    ...(kill ? { kill } : {}),
  }
}

function existingPath(path: string, directory = false): void {
  for (let parent = dirname(path); ; parent = dirname(parent)) {
    const stat = lstatSync(parent)
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('unsafe-operator-path')
    if (parent === parse(parent).root) break
  }
  const stat = lstatSync(path)
  if (
    stat.isSymbolicLink() ||
    (directory ? !stat.isDirectory() : !stat.isFile() || stat.nlink !== 1) ||
    (stat.mode & 0o022) !== 0 ||
    (process.getuid && stat.uid !== process.getuid())
  )
    throw new Error('unsafe-operator-path')
}

function policyAt(path: string): Policy {
  existingPath(path)
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  try {
    const stat = fstatSync(fd)
    if (!stat.isFile() || stat.size > 16_384) throw new Error('invalid-policy-file')
    return policySchema.parse(JSON.parse(readFileSync(fd, 'utf8')))
  } finally {
    closeSync(fd)
  }
}

export async function runWatchdogCli(
  argv: readonly string[],
  env: NodeJS.ProcessEnv = process.env,
): Promise<number> {
  let ledger: SqliteLedger | undefined
  let provider: LocalFakeProvider | undefined
  let objects: FileObjectStore | undefined
  try {
    const args = parseWatchdogArguments(argv)
    // This CLI ONLY reopens stores. Missing originals and markers are errors, never initialization.
    for (const path of [args.ledger, args.provider, `${args.provider}.p04-provider-identity`])
      existingPath(path)
    if (args.objects) {
      existingPath(args.objects, true)
      existingPath(`${args.objects}/.store.json`)
    }
    const contextSecret = env.P04_WORKER_CONTEXT_SECRET ?? ''
    const receiptSecret = env.P04_PROVIDER_RECEIPT_SECRET ?? ''
    const objectSecret = env.P04_OBJECT_SECRET ?? ''
    if (
      [contextSecret, receiptSecret, objectSecret].some((key) => Buffer.byteLength(key) < 32) ||
      new Set([contextSecret, receiptSecret, objectSecret]).size !== 3
    )
      throw new Error('private-keys-required')
    const policy = args.policy ? policyAt(args.policy) : undefined
    // Provider opens independently: if the ledger is unavailable, conservatively stop known resources
    // without asserting persistent kill, reconciliation, final billing or refunded liabilities.
    provider = new LocalFakeProvider({ path: args.provider, contextSecret, receiptSecret })
    try {
      ledger = new SqliteLedger({ path: args.ledger, receiptSecret, objectSecret, policy })
    } catch {
      const current = provider
      const resources = await providerCalls(current).run('inspect', providerCallTimeout(), () =>
        current.inspect(),
      )
      let outstanding = 0
      for (const resource of resources) {
        try {
          if (
            !isSettledReceipt(
              (
                await providerCalls(current).run(
                  `stop:${resource.execution.executionId}`,
                  providerCallTimeout(),
                  () => current.stop(resource.execution, 'shutdown'),
                )
              ).claims,
            )
          )
            outstanding++
        } catch {
          outstanding++
        }
      }
      console.log(
        JSON.stringify({
          mode: 'mock-diagnostic',
          paidExecutionAllowed: false,
          productionAllowed: false,
          error: 'ledger-unavailable-no-accounting-or-kill-proof',
          outstandingProviderResources: outstanding,
        }),
      )
      return 1
    }
    objects = args.objects ? new FileObjectStore({ root: args.objects, objectSecret }) : undefined
    const watchdog = new IndependentWatchdog({ ledger, provider, objects })
    const report = args.kill ? await watchdog.kill(args.kill) : await watchdog.tick()
    const current = provider
    const resources = (
      await providerCalls(current).run('inspect', providerCallTimeout(), () => current.inspect())
    ).map(({ execution, receipt }) => ({
      execution,
      outcome: receipt.claims.outcome,
      startForbidden: receipt.claims.startForbidden,
      terminationConfirmed: ['stopped', 'completed'].includes(receipt.claims.outcome),
      billingFinal: receipt.claims.finalMeter,
      outstanding: !isSettledReceipt(receipt.claims),
      receipt,
    }))
    console.log(
      JSON.stringify({
        mode: 'mock-diagnostic',
        paidExecutionAllowed: false,
        productionAllowed: false,
        externalProviderCapsProved: false,
        report,
        resources,
        quarantinedExecutions: ledger.snapshot().quarantinedExecutions,
      }),
    )
    return report.errors.length || report.retainedLiabilities ? 1 : 0
  } catch {
    // Deliberately do not echo arguments, environment, secrets, SQL or filesystem exception text.
    console.error(
      'P04 watchdog failed closed: check strict --once operator paths, existing stores, policy and private keys.',
    )
    return 1
  } finally {
    try {
      objects?.close()
    } catch {
      /* Close only this CLI's own handles. */
    }
    try {
      ledger?.close()
    } catch {
      /* Close only this CLI's own handles. */
    }
    try {
      await provider?.close()
    } catch {
      /* Handle close is not termination proof. */
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  process.exitCode = await runWatchdogCli(process.argv.slice(2))

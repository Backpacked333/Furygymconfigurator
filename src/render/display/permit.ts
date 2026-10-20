import { constants } from 'node:fs'
import { mkdir, open, realpath, unlink } from 'node:fs/promises'
import { localDisplayPermitSchema, type LocalDisplayPermit } from '../../display/session'
import { DISPLAY_LIMITS, stableDisplayJson } from '../../display/contract'
import { DISPLAY_HANDOFF, sha } from './build'
import { DISPLAY_OPERATOR_PATH, loadDisplayOperator } from '../../display/operator'

export const DISPLAY_OPERATOR_PERMIT = DISPLAY_OPERATOR_PATH

/** Provisioned operator file is an additional admission boundary; never created here. */
export async function checkOperatorPermit(input: LocalDisplayPermit) {
  const expected = localDisplayPermitSchema.parse(input)
  const provisioned = loadDisplayOperator()?.permit
  if (!provisioned) throw new Error('Execution denied: operator provision required.')
  if (
    stableDisplayJson(expected) !== stableDisplayJson(provisioned) ||
    Date.now() >= expected.expiresAt
  )
    throw new Error('Execution denied: missing/current operator permit required.')
  return expected
}
export interface DisplayRunJournal {
  readonly started: number
  readonly permit: LocalDisplayPermit
  check(): Promise<void>
  attempt(): Promise<void>
  output(bytes: number): Promise<void>
  finish(observedExit: boolean): Promise<void>
}

/** Independent renderer admission journal, not P04 or financial settlement. Existing run dirs
 * are never adopted/reset. Uncertain ownership lock is retained for external reconciliation. */
export async function ownDisplayRun(
  permit: LocalDisplayPermit,
  sessionId: string,
): Promise<DisplayRunJournal> {
  await checkOperatorPermit(permit)
  if ((await realpath(DISPLAY_HANDOFF)) !== DISPLAY_HANDOFF)
    throw new Error('Unexpected handoff root.')
  const syncDirectory = async (path: string) => {
    const dir = await open(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
    try {
      await dir.sync()
    } finally {
      await dir.close()
    }
  }
  const root = `${DISPLAY_HANDOFF}/renderer-runs`
  await mkdir(root, { mode: 0o700 }).catch((error) => {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
  })
  if ((await realpath(root)) !== root) throw new Error('Unsafe renderer journal.')
  await syncDirectory(DISPLAY_HANDOFF)
  const lockPath = `${root}/owned.lock`
  const lock = await open(
    lockPath,
    constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
    0o600,
  )
  const directory = `${root}/${permit.runId}`
  let sequence = 0,
    attempts = 0,
    outputBytes = 0,
    finished = false
  const started = Date.now(),
    permitDigest = sha(stableDisplayJson(permit))
  let writes = Promise.resolve(),
    finalizing: Promise<void> | undefined
  const append = (state: 'owned' | 'attempt' | 'output' | 'closed' | 'quarantined') =>
    (writes = writes.then(async () => {
      const file = await open(
        `${directory}/${String(sequence++).padStart(3, '0')}.json`,
        constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
        0o600,
      )
      try {
        await file.writeFile(
          stableDisplayJson({
            version: 1,
            state,
            sessionId,
            permitDigest,
            started,
            attempts,
            outputBytes,
            at: Date.now(),
            hostShutdownProven: false,
            billingFinal: false,
          }),
        )
        await file.sync()
      } finally {
        await file.close()
      }
      await syncDirectory(directory)
    }))
  try {
    await lock.writeFile(
      stableDisplayJson({
        runId: permit.runId,
        sessionId,
        permitDigest,
        started,
        ownerPid: process.pid,
      }),
    )
    await lock.sync()
    await mkdir(directory, { mode: 0o700 }) // EEXIST denies even a previously closed run.
    await syncDirectory(root)
    await append('owned')
  } catch (error) {
    await lock.close()
    // No process has been started yet; persistent run records, if any, remain immutable.
    await unlink(lockPath)
    throw error
  }
  await lock.close()
  const check = async () => {
    if (
      finished ||
      Date.now() - started >= DISPLAY_LIMITS.lifetimeMs ||
      attempts >= permit.maxJobs ||
      outputBytes + DISPLAY_LIMITS.pngBytes > permit.maxOutputBytes
    )
      throw new Error('Execution denied: local run exhausted/closed.')
    await checkOperatorPermit(permit)
    if (finished) throw new Error('Execution denied: run closed during allowance validation.')
  }
  return {
    started,
    permit,
    check,
    async attempt() {
      await check()
      if (finished || attempts >= permit.maxJobs)
        throw new Error('Execution denied: run exhausted/closed.')
      attempts++
      await append('attempt')
    },
    async output(bytes) {
      if (
        finished ||
        !Number.isSafeInteger(bytes) ||
        bytes < 1 ||
        bytes > DISPLAY_LIMITS.pngBytes ||
        outputBytes + bytes > permit.maxOutputBytes
      )
        throw new Error('Local output budget exceeded.')
      outputBytes += bytes
      await append('output')
    },
    finish(observedExit) {
      return (finalizing ??= (async () => {
        finished = true
        await append(observedExit ? 'closed' : 'quarantined')
        if (observedExit) {
          await unlink(lockPath)
          await syncDirectory(root)
        }
      })())
    },
  }
}

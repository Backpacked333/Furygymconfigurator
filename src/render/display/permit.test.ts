import { beforeEach, describe, expect, it, vi } from 'vitest'
import { constants } from 'node:fs'
import { mkdir, open, realpath, unlink } from 'node:fs/promises'
import { DISPLAY_LIMITS } from '../../display/contract'
import type { LocalDisplayPermit } from '../../display/session'
import { checkOperatorPermit, DISPLAY_OPERATOR_PERMIT, ownDisplayRun } from './permit'
import { DISPLAY_HANDOFF } from './build'
import { loadDisplayOperator } from '../../display/operator'
vi.mock('../../display/operator', () => ({
  DISPLAY_OPERATOR_PATH: '/test-only-no-real-files/operator.json',
  loadDisplayOperator: vi.fn(),
}))

vi.mock('node:fs/promises', async (original) => ({
  ...(await original<typeof import('node:fs/promises')>()),
  mkdir: vi.fn(),
  open: vi.fn(),
  realpath: vi.fn(),
  unlink: vi.fn(),
}))
vi.mock('./build', () => ({
  DISPLAY_HANDOFF: '/test-only-no-real-files',
  trustedBytes: vi.fn(),
  sha: () => `sha256:${'a'.repeat(64)}`,
}))
const permit: LocalDisplayPermit = {
  kind: 'operator-local-only',
  runId: 't'.repeat(32),
  approvalReference: 'TEST ONLY NOT AUTHORIZATION',
  expiresAt: Date.now() + 600000,
  maxJobs: 1,
  maxOutputBytes: DISPLAY_LIMITS.pngBytes,
  paidExecutionAllowed: false,
  productionAllowed: false,
}
const files = new Map<string, string>(),
  directories = new Set<string>(),
  sync = vi.fn()
const exists = () => Object.assign(new Error('EEXIST'), { code: 'EEXIST' })
const lock = `${DISPLAY_HANDOFF}/renderer-runs/owned.lock`
beforeEach(() => {
  vi.clearAllMocks()
  files.clear()
  directories.clear()
  files.set(DISPLAY_OPERATOR_PERMIT, JSON.stringify(permit))
  directories.add(DISPLAY_HANDOFF)
  vi.mocked(loadDisplayOperator).mockImplementation(() => ({
    version: 1,
    permit: JSON.parse(files.get(DISPLAY_OPERATOR_PERMIT)!),
    ownerId: 't'.repeat(32),
    credential: 'a'.repeat(64),
  }))
  vi.mocked(realpath).mockImplementation(async (path) => String(path))
  vi.mocked(mkdir).mockImplementation(async (path) => {
    if (directories.has(String(path))) throw exists()
    directories.add(String(path))
    return undefined
  })
  vi.mocked(unlink).mockImplementation(async (path) => {
    files.delete(String(path))
  })
  vi.mocked(open).mockImplementation(async (path, flags) => {
    const name = String(path)
    if (typeof flags === 'number' && flags & constants.O_EXCL) {
      if (files.has(name)) throw exists()
      files.set(name, '')
    }
    if (!files.has(name) && !directories.has(name)) throw new Error('Test file absent')
    return {
      stat: async () => ({ uid: process.getuid?.(), mode: 0o600 }),
      writeFile: async (value: string) => {
        files.set(name, value)
      },
      sync,
      close: async () => {},
    } as unknown as Awaited<ReturnType<typeof open>>
  })
})
describe('durable allowance semantics with an in-memory filesystem only (no real permit or run)', () => {
  it('requires exact provisioned permission and rejects expiry or changed flags', async () => {
    expect(await checkOperatorPermit(permit)).toEqual(permit)
    await expect(
      checkOperatorPermit({ ...permit, approvalReference: 'different' }),
    ).rejects.toThrow()
    await expect(checkOperatorPermit({ ...permit, expiresAt: 1 })).rejects.toThrow()
    await expect(
      checkOperatorPermit({
        ...permit,
        paidExecutionAllowed: true,
      } as unknown as LocalDisplayPermit),
    ).rejects.toThrow()
  })
  it('durably consumes attempted jobs; a successful close releases the lock but never resets a run ID', async () => {
    const journal = await ownDisplayRun(permit, 's'.repeat(32))
    expect(files.has(lock)).toBe(true)
    await journal.attempt()
    await expect(journal.attempt()).rejects.toThrow('exhausted')
    await journal.output(44)
    await journal.finish(true)
    expect(files.has(lock)).toBe(false)
    expect(sync).toHaveBeenCalled()
    await expect(ownDisplayRun(permit, 'u'.repeat(32))).rejects.toThrow('EEXIST')
    const record = JSON.parse(
      files.get(`${DISPLAY_HANDOFF}/renderer-runs/${permit.runId}/003.json`)!,
    )
    expect(record).toMatchObject({
      state: 'closed',
      attempts: 1,
      outputBytes: 44,
      hostShutdownProven: false,
      billingFinal: false,
    })
  })
  it('uncertain teardown retains quarantine and idempotent finish cannot convert it into observed exit', async () => {
    const journal = await ownDisplayRun(permit, 's'.repeat(32))
    const closing = journal.finish(false)
    expect(journal.finish(true)).toBe(closing)
    await closing
    expect(files.has(lock)).toBe(true)
    await expect(ownDisplayRun(permit, 'u'.repeat(32))).rejects.toThrow('EEXIST')
    await expect(journal.attempt()).rejects.toThrow('closed')
  })
  it('bounds aggregate output and reserves worst-case bytes before another mutation', async () => {
    const journal = await ownDisplayRun(permit, 's'.repeat(32))
    await expect(journal.output(DISPLAY_LIMITS.pngBytes + 1)).rejects.toThrow('budget')
    await journal.output(DISPLAY_LIMITS.pngBytes)
    await expect(journal.output(1)).rejects.toThrow('budget')
    await expect(journal.check()).rejects.toThrow('exhausted')
    await journal.finish(true)
  })
})

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync, openSync, closeSync, fstatSync, readSync, realpathSync } from 'node:fs'
import { DISPLAY_OPERATOR_DIRECTORY, DISPLAY_OPERATOR_PATH, loadDisplayOperator } from './operator'
import { DISPLAY_LIMITS } from './contract'
vi.mock('node:fs', async (original) => ({
  ...(await original<typeof import('node:fs')>()),
  existsSync: vi.fn(),
  openSync: vi.fn(),
  closeSync: vi.fn(),
  fstatSync: vi.fn(),
  readSync: vi.fn(),
  realpathSync: vi.fn(),
}))
const value = {
  version: 1,
  ownerId: 'test_only_owner_000000000000',
  credential: 'a'.repeat(64),
  permit: {
    kind: 'operator-local-only',
    runId: 'test_only_run_00000000000000',
    approvalReference: 'TEST ONLY - NO REAL AUTHORIZATION',
    expiresAt: Date.now() + 1000,
    maxJobs: 1,
    maxOutputBytes: DISPLAY_LIMITS.pngBytes,
    paidExecutionAllowed: false,
    productionAllowed: false,
  },
}
let body: Buffer, mode: number, link: boolean
beforeEach(() => {
  vi.clearAllMocks()
  body = Buffer.from(JSON.stringify(value))
  mode = 0o600
  link = false
  vi.mocked(existsSync).mockReturnValue(true)
  vi.mocked(realpathSync).mockImplementation((path) => (link ? 'other-path' : String(path)))
  vi.mocked(openSync).mockImplementation((path) =>
    String(path) === DISPLAY_OPERATOR_DIRECTORY ? 1 : 2,
  )
  vi.mocked(fstatSync).mockImplementation(
    (fd) =>
      ({
        uid: process.getuid?.(),
        mode: fd === 1 ? 0o700 : mode,
        isFile: () => true,
        nlink: 1,
        size: body.length,
        mtimeMs: 1,
        ctimeMs: 1,
      }) as ReturnType<typeof fstatSync>,
  )
  vi.mocked(readSync).mockImplementation(((
    _fd: number,
    buffer: Buffer,
    offset: number,
    length: number,
    position: number,
  ) => body.copy(buffer, offset, position, position + length)) as typeof readSync)
})
describe('shared renderer/service private provision loader using only in-memory file doubles', () => {
  it('has exactly one fixed authority and never creates a provision', () => {
    expect(DISPLAY_OPERATOR_PATH).toBe(`${DISPLAY_OPERATOR_DIRECTORY}/operator.json`)
    expect(loadDisplayOperator()).toEqual(value)
    expect(openSync).toHaveBeenCalledTimes(2)
    expect(closeSync).toHaveBeenCalledTimes(2)
    vi.mocked(existsSync).mockReturnValue(false)
    expect(loadDisplayOperator()).toBeNull()
    expect(openSync).toHaveBeenCalledTimes(2)
  })
  it('rejects insecure, symlinked, corrupt or permissive provisions', () => {
    mode = 0o644
    expect(() => loadDisplayOperator()).toThrow('private')
    mode = 0o600
    link = true
    expect(() => loadDisplayOperator()).toThrow('Unsafe')
    link = false
    body = Buffer.from('{')
    expect(() => loadDisplayOperator()).toThrow()
    body = Buffer.from(
      JSON.stringify({ ...value, permit: { ...value.permit, paidExecutionAllowed: true } }),
    )
    expect(() => loadDisplayOperator()).toThrow()
    body = Buffer.from(JSON.stringify({ ...value, endpoint: 'https://remote.invalid' }))
    expect(() => loadDisplayOperator()).toThrow()
  })
})

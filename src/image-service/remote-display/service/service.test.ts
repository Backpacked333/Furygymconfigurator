import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, symlinkSync, linkSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { defaultDesign, type DesignEnvelope } from '../../../domain/design'
import {
  bindCloudRecipe,
  CLOUD_DISPLAY_PROTOCOL,
  createCloudDisplayRequest,
} from '../../../display/cloudContract'
import { DISPLAY_LIMITS, type DisplayBuild } from '../../../display/contract'
import { displayCameraDigest } from '../../../render/display/input'
import { DisplayDirectory, hash } from '../../display/files'
import { createCloudDisplayService, type CloudDisplayService } from './service'
import { CloudJournal } from './journal'
import { CloudCache } from './cache'

const roots: string[] = [],
  services: CloudDisplayService[] = []
const owner = 'inert_cloud_owner_123456789012',
  other = 'inert_other_owner_123456789012'
const build: DisplayBuild = {
  sourceManifestDigest: hash('source'),
  assetManifestDigest: hash('assets'),
  bundleDigest: hash('bundle'),
  lockfileDigest: hash('lock'),
  runtimePolicyDigest: hash('runtime'),
  threeRevision: '186',
}
function root() {
  const path = mkdtempSync(join(tmpdir(), 'fury-display-cloud-test-'))
  roots.push(path)
  return path
}
async function recipe(design: DesignEnvelope = defaultDesign(), variant = '') {
  return bindCloudRecipe(
    design,
    build,
    hash(`package${variant}`),
    await displayCameraDigest(design),
  )
}
function backend() {
  return {
    prepare: vi.fn(async (design: DesignEnvelope) => recipe(design)),
    revalidate: vi.fn(async () => {}),
    open: vi.fn(async () => {
      throw new Error('ZERO-CALL SENTINEL: no session may open')
    }),
    close: vi.fn(async () => {}),
  }
}
afterEach(async () => {
  for (const s of services.splice(0)) await s.close()
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true })
})

describe('cloud service immutable production hold', () => {
  it('unconfigured denies before preparation, ownership, browser or provider side effects', async () => {
    const driver = backend(),
      s = createCloudDisplayService({ backend: driver })
    services.push(s)
    await expect(s.submit(owner, createCloudDisplayRequest(defaultDesign()))).rejects.toMatchObject(
      { status: 503, wire: { blocker: 'not-configured' } },
    )
    expect(driver.prepare).not.toHaveBeenCalled()
    expect(driver.open).not.toHaveBeenCalled()
  })
  it('strict full-design cloud miss prepares/revalidates but does not enqueue, reserve or open even with truthy approval', async () => {
    const path = root(),
      driver = backend(),
      s = createCloudDisplayService({
        backend: driver,
        directory: path,
        approval: { paidExecutionAllowed: true },
      })
    services.push(s)
    await expect(s.submit(owner, createCloudDisplayRequest(defaultDesign()))).rejects.toMatchObject(
      { wire: { code: 'execution-denied', blocker: 'approval-required' } },
    )
    expect(driver.prepare).toHaveBeenCalledOnce()
    expect(driver.revalidate).toHaveBeenCalledOnce()
    expect(driver.open).not.toHaveBeenCalled()
    expect(new DisplayDirectory(join(path, 'cloud-journal')).names(3)).toEqual(['writer.json'])
    await expect(
      s.submit(owner, { ...createCloudDisplayRequest(defaultDesign()), provider: 'modal' }),
    ).rejects.toMatchObject({ status: 422 })
    await expect(
      s.submit(owner, { protocol: 'fury.private-display@1', design: defaultDesign() }),
    ).rejects.toMatchObject({ status: 422 })
    await expect(
      s.submit('foreign', createCloudDisplayRequest(defaultDesign())),
    ).rejects.toMatchObject({ status: 403 })
    expect(driver.prepare).toHaveBeenCalledOnce()
    expect(driver.open).not.toHaveBeenCalled()
  })
  it('rejects source/camera/package identity tampering and aborted submissions without dispatch', async () => {
    const driver = backend(),
      r = await recipe()
    driver.prepare.mockResolvedValue({ ...r, cameraDigest: hash('browser chosen camera') })
    const s = createCloudDisplayService({ backend: driver, directory: root() })
    services.push(s)
    await expect(s.submit(owner, createCloudDisplayRequest(defaultDesign()))).rejects.toThrow()
    const abort = new AbortController()
    abort.abort()
    await expect(
      s.submit(owner, createCloudDisplayRequest(defaultDesign()), abort.signal),
    ).rejects.toThrow()
    expect(driver.prepare).toHaveBeenCalledOnce()
    expect(driver.open).not.toHaveBeenCalled()
  })
})
describe('durable cloud queue and owner ledger, inert metadata only', () => {
  it('coalesces exact interests, isolates owners, preserves cancellation scope and counters across restart quarantine', async () => {
    const directory = new DisplayDirectory(root()),
      journal = new CloudJournal(directory),
      r = await recipe()
    const first = journal.add(owner, defaultDesign(), r, false),
      second = journal.add(other, defaultDesign(), r, false)
    expect(() => journal.get(other, first.id)).toThrow()
    expect(journal.reserve(r.recipeDigest)).toBe(1)
    expect(() => journal.reserve(r.recipeDigest)).toThrow()
    journal.attach('inert_external_session_123456789')
    journal.cancel(owner, first.id)
    expect(journal.interested(r.recipeDigest)).toBe(true)
    expect(journal.get(other, second.id).state).toBe('rendering')
    journal.output(100)
    journal.poison()
    const before = journal.snapshot().run
    expect(before).toMatchObject({
      claimed: true,
      poisoned: true,
      attempts: 1,
      outputBytes: 100,
      terminationRequested: true,
      terminationEvidence: null,
      billingEvidence: null,
    })
    journal.close()
    const restarted = new CloudJournal(directory)
    expect(restarted.restartedRun).toBe(true)
    expect(restarted.snapshot().run).toEqual(before)
    expect(() => restarted.add(owner, defaultDesign(), r, false)).toThrow()
    expect(() => restarted.reserve(r.recipeDigest)).toThrow()
    restarted.close()
  })
  it('cache-hit bookkeeping never reserves jobs and survives clean metadata-only restart', async () => {
    const directory = new DisplayDirectory(root()),
      journal = new CloudJournal(directory),
      r = await recipe()
    const interest = journal.add(owner, defaultDesign(), r, true)
    expect(journal.snapshot().run).toMatchObject({ claimed: false, attempts: 0, outputBytes: 0 })
    journal.close()
    const restarted = new CloudJournal(directory)
    expect(restarted.get(owner, interest.id)).toMatchObject({
      hit: true,
      state: 'ready',
      recipe: r,
    })
    expect(restarted.restartedRun).toBe(false)
    restarted.close()
  })
  it('bounds queue to four distinct recipes and interests to 32; returns do not mint a new session', async () => {
    const journal = new CloudJournal(new DisplayDirectory(root())),
      r = await recipe()
    for (let i = 0; i < DISPLAY_LIMITS.queuedJobs; i++)
      journal.add(owner, defaultDesign(), await recipe(defaultDesign(), String(i)), false)
    expect(() => journal.add(owner, defaultDesign(), r, false)).toThrow()
    for (let i = 4; i < DISPLAY_LIMITS.interests; i++) journal.add(owner, defaultDesign(), r, true)
    expect(() => journal.add(owner, defaultDesign(), r, true)).toThrow()
    expect(journal.snapshot().run.attempts).toBe(0)
    journal.close()
  })
  it('exclusive writer, partial checkpoints, edited counters and file links fail closed', async () => {
    const directory = new DisplayDirectory(root()),
      j = new CloudJournal(directory),
      r = await recipe()
    expect(() => new CloudJournal(directory)).toThrow()
    j.add(owner, defaultDesign(), r, false)
    j.reserve(r.recipeDigest)
    j.close()
    const second = directory.file('state-002.json')
    const value = JSON.parse(readFileSync(second, 'utf8'))
    value.run.attempts = -1
    writeFileSync(second, JSON.stringify(value), { mode: 0o600 })
    expect(() => new CloudJournal(directory)).toThrow()
    const partial = new DisplayDirectory(root())
    writeFileSync(partial.file('state-001.json'), '{', { mode: 0o600 })
    expect(() => new CloudJournal(partial)).toThrow()
    const linked = new DisplayDirectory(root())
    symlinkSync(second, linked.file('state-001.json'))
    expect(() => new CloudJournal(linked)).toThrow()
    const hard = new DisplayDirectory(root())
    linkSync(second, hard.file('state-001.json'))
    expect(() => new CloudJournal(hard)).toThrow()
  })
  it('caps attempts and output accounting without allocating images or resetting counters', async () => {
    const journal = new CloudJournal(new DisplayDirectory(root())),
      r = await recipe()
    for (let i = 0; i < DISPLAY_LIMITS.jobsPerSession; i++) {
      journal.add(owner, defaultDesign(), r, false)
      expect(journal.reserve(r.recipeDigest)).toBe(i + 1)
      if (i < 8) journal.output(DISPLAY_LIMITS.pngBytes)
      journal.complete(r.recipeDigest)
    }
    expect(journal.snapshot().run.outputBytes).toBe(DISPLAY_LIMITS.sessionOutputBytes)
    expect(() => journal.output(44)).toThrow()
    journal.add(owner, defaultDesign(), r, false)
    expect(() => journal.reserve(r.recipeDigest)).toThrow()
    expect(journal.snapshot().run.attempts).toBe(DISPLAY_LIMITS.jobsPerSession)
    journal.close()
  })
  it('enforces lifetime and non-resettable attempts without executing jobs', async () => {
    let now = 1_000
    const journal = new CloudJournal(new DisplayDirectory(root()), () => now),
      r = await recipe()
    journal.add(owner, defaultDesign(), r, false)
    journal.reserve(r.recipeDigest)
    journal.complete(r.recipeDigest)
    now += DISPLAY_LIMITS.lifetimeMs
    journal.add(owner, defaultDesign(), r, false)
    expect(() => journal.reserve(r.recipeDigest)).toThrow()
    expect(journal.snapshot().run.attempts).toBe(1)
    journal.close()
  })
})
describe('separate cloud cache storage', () => {
  it('cannot import local/P04 metadata or orphaned image bytes as a cloud cache hit', async () => {
    const directory = new DisplayDirectory(root()),
      cache = new CloudCache(directory),
      r = await recipe()
    expect(await cache.get(r)).toBeNull()
    directory.exclusive(
      `${r.recipeDigest.slice(7)}.json`,
      Buffer.from(
        JSON.stringify({ kind: 'private-three-display', protocol: CLOUD_DISPLAY_PROTOCOL }),
      ),
    )
    await expect(cache.get(r)).rejects.toThrow()
  })
})

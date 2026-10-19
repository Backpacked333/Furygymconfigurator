// Node-only synthetic decoding/publication tests. No browser, scene rendering or quality evidence.
import { mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  CAPTURE_LIMITS,
  CaptureContractError,
  LOCAL_REVIEW_PROFILES,
  createCaptureJob,
  createCaptureSamples,
  validateDecodedArtifact,
} from './contract'
import {
  ExclusiveDirectory,
  decodeCapturePng,
  digest,
  matchesObservedBrowserRuntime,
  publishCapture,
} from './artifacts'
import { TEST_BUILD, syntheticPng, syntheticResult, testChunk } from './artifacts-fixtures'
const dirs: string[] = []
async function temp() {
  const dir = await mkdtemp(join(tmpdir(), 'fury-artifacts-test-'))
  dirs.push(dir)
  return dir
}
afterEach(async () => {
  vi.restoreAllMocks()
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})
async function setup() {
  const parent = await temp(),
    directory = await ExclusiveDirectory.create(join(parent, 'attempt'))
  const sample = createCaptureSamples()[0],
    job = await createCaptureJob('synthetic-attempt', sample.id, sample.request, TEST_BUILD)
  return {
    directory,
    job,
    result: syntheticResult(job),
    elapsedMs: () => 50,
    fence: () => {},
    revalidateSources: async () => {},
  }
}
describe('observed browser identity (synthetic metadata only)', () => {
  const observation = (pageVersion: string, product: string) => ({
    userAgent: `Synthetic test only ${pageVersion} Safari/537.36`,
    product,
  })
  it.each([
    ['HeadlessChrome/137.0.0.0', 'Chrome/137.0.7118.2'],
    ['Chrome/137.0.0.0', 'Chrome/137.0.7118.2'],
    ['HeadlessChrome/137.0.7118.2', 'Chrome/137.0.7118.2'],
    ['Chrome/137.0.7118.2', 'HeadlessChrome/137.0.7118.2'],
  ])('accepts %s with observed %s without rewriting provenance', (browserVersion, product) => {
    const observed = observation(browserVersion, product)
    const runtime = { userAgent: observed.userAgent, browserVersion }
    const before = JSON.stringify({ runtime, observed })
    expect(matchesObservedBrowserRuntime(runtime, observed)).toBe(true)
    expect(JSON.stringify({ runtime, observed })).toBe(before)
  })
  it.each([
    ['HeadlessChrome/136.0.0.0', 'Chrome/137.0.7118.2'],
    ['HeadlessChrome/137.0.7118.1', 'Chrome/137.0.7118.2'],
    ['HeadlessChrome/137.1.0.0', 'Chrome/137.0.7118.2'],
    ['HeadlessChrome/137.0.0.1', 'Chrome/137.0.7118.2'],
    ['HeadlessChrome/137.0.0.0', 'Firefox/137.0.7118.2'],
    ['HeadlessChrome/137.0.0.0', ''],
    ['Test/1', 'Test/1'],
    ['NotChrome/137.0.0.0', 'Chrome/137.0.7118.2'],
    ['Chrome/137.0.0.0.1', 'Chrome/137.0.7118.2'],
    ['Chrome/137.0.0', 'Chrome/137.0.7118.2'],
  ])('rejects %s with observed %s', (browserVersion, product) => {
    const observed = observation(browserVersion, product)
    expect(
      matchesObservedBrowserRuntime({ userAgent: observed.userAgent, browserVersion }, observed),
    ).toBe(false)
  })
  it('requires exact page/CDP UA and the page-derived version, not the full CDP product', () => {
    const observed = observation('HeadlessChrome/137.0.0.0', 'Chrome/137.0.7118.2')
    expect(
      matchesObservedBrowserRuntime(
        { userAgent: observed.userAgent + ' changed', browserVersion: 'HeadlessChrome/137.0.0.0' },
        observed,
      ),
    ).toBe(false)
    expect(
      matchesObservedBrowserRuntime(
        { userAgent: observed.userAgent, browserVersion: observed.product },
        observed,
      ),
    ).toBe(false)
  })
})

describe('bounded independent PNG decoder', () => {
  for (const channels of [3, 4] as const)
    for (const filter of [0, 1, 2, 3, 4])
      it(`decodes RGB${channels * 8} filter ${filter} using independent synthetic encoding`, async () => {
        const fixture = syntheticPng({ channels, filter })
        const decoded = decodeCapturePng(fixture.png, LOCAL_REVIEW_PROFILES.wide)
        expect(Buffer.from(decoded.rgba).equals(Buffer.from(fixture.rgba))).toBe(true)
        expect(
          (await validateDecodedArtifact(LOCAL_REVIEW_PROFILES.wide, fixture.png, decoded)).pixels
            .opaquePixels,
        ).toBe(640 * 400)
      })
  it('decodes the independent portrait profile', () => {
    const fixture = syntheticPng({ profile: LOCAL_REVIEW_PROFILES.tall })
    expect(
      Buffer.from(decodeCapturePng(fixture.png, LOCAL_REVIEW_PROFILES.tall).rgba).equals(
        Buffer.from(fixture.rgba),
      ),
    ).toBe(true)
  })
  it.each([
    ['wrong dimensions', { header: (h: Buffer) => h.writeUInt32BE(600) }],
    [
      'bit depth',
      {
        header: (h: Buffer) => {
          h[8] = 16
        },
      },
    ],
    [
      'interlace',
      {
        header: (h: Buffer) => {
          h[12] = 1
        },
      },
    ],
    [
      'palette',
      {
        header: (h: Buffer) => {
          h[9] = 3
        },
      },
    ],
    ['filter', { filter: 5 }],
    ['inflate cap', { inflateExtra: 1 }],
    ['compressed trailing bytes', { compressedSuffix: Buffer.from([1, 2, 3]) }],
    ['APNG', { extra: [testChunk('acTL', Buffer.alloc(8))] }],
    ['unknown chunk', { extra: [testChunk('zzZZ', Buffer.alloc(1))] }],
    [
      'duplicate hint',
      { extra: [testChunk('sRGB', Buffer.from([0])), testChunk('sRGB', Buffer.from([0]))] },
    ],
  ])('rejects %s', (_name, options) => {
    expect(() => decodeCapturePng(syntheticPng(options).png, LOCAL_REVIEW_PROFILES.wide)).toThrow(
      CaptureContractError,
    )
  })
  it('rejects bad CRC, truncation, trailing data and over-byte-cap before pixels', () => {
    const png = syntheticPng().png,
      corrupt = Buffer.from(png)
    corrupt[corrupt.length - 1] ^= 1
    for (const bytes of [
      corrupt,
      png.subarray(0, -1),
      Buffer.concat([png, Buffer.from([0])]),
      Buffer.alloc(CAPTURE_LIMITS.pngBytes + 1),
    ])
      expect(() => decodeCapturePng(bytes, LOCAL_REVIEW_PROFILES.wide)).toThrow(
        CaptureContractError,
      )
  })
  it.each([{ blank: true }, { transparent: true }])(
    'rejects decoded bad pixels %j',
    async (options) => {
      const { png } = syntheticPng(options)
      await expect(
        validateDecodedArtifact(
          LOCAL_REVIEW_PROFILES.wide,
          png,
          decodeCapturePng(png, LOCAL_REVIEW_PROFILES.wide),
        ),
      ).rejects.toMatchObject({ code: 'bad-pixels' })
    },
  )
})
describe('exclusive immutable publication', () => {
  it('publishes the completion link last after independently decoded bytes and receipt readback', async () => {
    const options = await setup(),
      order: string[] = []
    const write = options.directory.write.bind(options.directory)
    vi.spyOn(options.directory, 'write').mockImplementation(async (name, bytes, max) => {
      order.push(name)
      await write(name, bytes, max)
    })
    const marker = await publishCapture(options)
    expect(order).toEqual(['image.png', 'receipt.json', 'COMPLETE.pending.json'])
    const png = await readFile(join(options.directory.path, 'image.png'))
    const receipt = await readFile(join(options.directory.path, 'receipt.json'))
    expect(marker.image.digest).toBe(digest(png))
    expect(marker.receipt.digest).toBe(digest(receipt))
    expect(
      JSON.parse((await readFile(join(options.directory.path, 'COMPLETE.json'))).toString()),
    ).toEqual(marker)
    expect(decodeCapturePng(png, options.job.profile).width).toBe(640)
    await expect(publishCapture(options)).rejects.toThrow()
    expect(await readFile(join(options.directory.path, 'image.png'))).toEqual(png)
  })
  it('never adopts existing or symlink output parents', async () => {
    const parent = await temp(),
      target = join(parent, 'existing')
    await ExclusiveDirectory.create(target)
    await expect(ExclusiveDirectory.create(target)).rejects.toThrow()
    await symlink(target, join(parent, 'link'))
    await expect(ExclusiveDirectory.create(join(parent, 'link', 'child'))).rejects.toThrow()
  })
  it.each(['image.png', 'receipt.json', 'COMPLETE.pending.json'])(
    'preserves partial files with no COMPLETE on %s write failure',
    async (failingName) => {
      const options = await setup(),
        write = options.directory.write.bind(options.directory)
      vi.spyOn(options.directory, 'write').mockImplementation(async (name, bytes, max) => {
        if (name === failingName) throw new Error('Synthetic disk failure')
        await write(name, bytes, max)
      })
      await expect(publishCapture(options)).rejects.toThrow('Synthetic disk failure')
      expect(await readdir(options.directory.path)).not.toContain('COMPLETE.json')
    },
  )
  it('detects tampering on readback before commit', async () => {
    const options = await setup()
    options.revalidateSources = async () => {
      await writeFile(join(options.directory.path, 'image.png'), 'synthetic corruption')
    }
    await expect(publishCapture(options)).rejects.toMatchObject({ code: 'publication-failed' })
    expect(await readdir(options.directory.path)).not.toContain('COMPLETE.json')
  })
  it('fences source changes and cancellation immediately before linking', async () => {
    const options = await setup()
    options.revalidateSources = async () => {
      throw new CaptureContractError('identity-mismatch', 'Synthetic changed source')
    }
    await expect(publishCapture(options)).rejects.toMatchObject({ code: 'identity-mismatch' })
    expect(await readdir(options.directory.path)).not.toContain('COMPLETE.json')
    const other = await setup(),
      commit = other.directory.commit.bind(other.directory)
    vi.spyOn(other.directory, 'commit').mockImplementation((pending, final, bytes) =>
      commit(pending, final, bytes, () => {
        throw new CaptureContractError('cancelled', 'Synthetic cancellation')
      }),
    )
    await expect(publishCapture(other)).rejects.toMatchObject({ code: 'cancelled' })
    expect(await readdir(other.directory.path)).not.toContain('COMPLETE.json')
  })
})

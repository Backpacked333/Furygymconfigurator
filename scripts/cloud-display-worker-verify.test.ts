import { describe, expect, it } from 'vitest'
import { parseCloudWorkerVerifyArgs, verifyCloudWorker } from './cloud-display-worker-verify'

describe('cloud worker real offline source/private-browser preparation', () => {
  it('allows only verify-only with no execution/provider/output flags', () => {
    expect(() => parseCloudWorkerVerifyArgs(['--verify-only'])).not.toThrow()
    for (const args of [
      [],
      ['--render'],
      ['--verify-only', '--deploy'],
      ['--verify-only', '--output', '/tmp/x'],
    ])
      expect(() => parseCloudWorkerVerifyArgs(args)).toThrow()
  })
  it('packages current bytes, private scene and light worker without any image/provider execution', async () => {
    const report = await verifyCloudWorker()
    expect(report.dispatchAllowed).toBe(false)
    expect(report.renderCalls).toBe(0)
    expect(report.providerCalls).toBe(0)
    expect(report.browserStarts).toBe(0)
    expect(report.runtimeImageConfigured).toBe(false)
    expect(report.records.some((r) => r.name === 'src/display/cloudSession.ts')).toBe(true)
    expect(
      report.records.some((r) => r.name === 'src/image-service/remote-display/worker/backend.ts'),
    ).toBe(true)
    expect(
      report.records.some((r) => /private-browser\/assets\/siteLight\.worker.*\.js$/.test(r.name)),
    ).toBe(true)
    expect(
      report.records.some((r) => r.name.startsWith('public/textures/') && r.name.endsWith('.webp')),
    ).toBe(true)
    expect(
      report.records.some((r) => /fakeRenderer|operator\.json|\.png$|\.git\//.test(r.name)),
    ).toBe(false)
    expect(report.recipe.workerPackageDigest).toBe(report.packageDigest)
    const repeated = await verifyCloudWorker()
    expect(repeated.packageDigest).toBe(report.packageDigest)
    expect(repeated.build).toEqual(report.build)
    expect(repeated.records).toEqual(report.records)
  }, 120000)
})

import { describe, expect, it } from 'vitest'
import { fileURLToPath } from 'node:url'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import {
  parseCloudServiceVerifyArgs,
  verifyCloudServiceSource,
} from './cloud-display-service-verify'

describe('cloud service source-only verification', () => {
  it('rejects every invocation except explicit verify-only', () => {
    expect(() => parseCloudServiceVerifyArgs(['--verify-only'])).not.toThrow()
    for (const args of [
      [],
      ['--run'],
      ['--verify-only', '--run'],
      ['--verify-only', '--output', '/tmp/anything'],
    ])
      expect(() => parseCloudServiceVerifyArgs(args)).toThrow('Only --verify-only')
  })
  it('runs the offline CLI with the actual Node loader, without service or worker startup', async () => {
    const script = fileURLToPath(new URL('./cloud-display-service-verify.ts', import.meta.url))
    const { stdout } = await promisify(execFile)(process.execPath, [script, '--verify-only'], {
      timeout: 10000,
    })
    expect(JSON.parse(stdout)).toMatchObject({
      executionAuthorized: false,
      providerCalls: 0,
      renderedImages: 0,
    })
  })
  it('holds dispatch and separates the cloud receipt/storage/private namespace', async () => {
    const result = await verifyCloudServiceSource(fileURLToPath(new URL('..', import.meta.url)))
    expect(Object.values(result.checks).every(Boolean)).toBe(true)
    expect(result).toMatchObject({
      providerCalls: 0,
      renderedImages: 0,
      executionAuthorized: false,
      observedProviderTermination: 'unobserved',
      observedBillingFinal: 'unobserved',
    })
  })
})

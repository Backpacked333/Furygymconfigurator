import { describe, expect, it } from 'vitest'
import { defaultDesign } from '../domain/design'
import { DISPLAY_PROTOCOL, displayRequestSchema } from './contract'
import { localDisplayPermitSchema } from './session'
import {
  bindCloudRecipe,
  cloudDisplayRequestSchema,
  cloudObservationSchema,
  createCloudDisplayRequest,
  isCloudDisplaySelection,
  parseCloudDisplayReply,
  CLOUD_DISPLAY_BUILD_GATE,
  CLOUD_DISPLAY_MODE,
  CLOUD_DISPLAY_PROTOCOL,
} from './cloudContract'

const digest = `sha256:${'a'.repeat(64)}`
const build = {
  sourceManifestDigest: digest,
  assetManifestDigest: digest,
  bundleDigest: digest,
  lockfileDigest: digest,
  runtimePolicyDigest: digest,
  threeRevision: '186',
}
const design = defaultDesign()

describe('cloud contract metadata only: no provider, process or pixels', () => {
  it('retains the exact full design but never accepts browser execution controls', () => {
    const request = createCloudDisplayRequest(design)
    expect(request.design).toEqual(design)
    for (const key of [
      'provider',
      'endpoint',
      'gpu',
      'script',
      'budget',
      'priority',
      'url',
      'mesh',
      'camera',
      'permit',
    ])
      expect(cloudDisplayRequestSchema.safeParse({ ...request, [key]: 'injected' }).success).toBe(
        false,
      )
    expect(displayRequestSchema.safeParse(request).success).toBe(false)
    expect(
      cloudDisplayRequestSchema.safeParse({ ...request, protocol: DISPLAY_PROTOCOL }).success,
    ).toBe(false)
  })
  it('keys recipe by full binding, camera and worker package with exact return identity', async () => {
    const first = await bindCloudRecipe(design, build, digest, digest)
    expect(await bindCloudRecipe(design, build, digest, digest)).toEqual(first)
    const other = `sha256:${'b'.repeat(64)}`
    expect((await bindCloudRecipe(design, build, other, digest)).recipeDigest).not.toBe(
      first.recipeDigest,
    )
    expect((await bindCloudRecipe(design, build, digest, other)).recipeDigest).not.toBe(
      first.recipeDigest,
    )
    expect(
      (await bindCloudRecipe(design, { ...build, runtimePolicyDigest: other }, digest, digest))
        .recipeDigest,
    ).not.toBe(first.recipeDigest)
    const reply = {
      protocol: CLOUD_DISPLAY_PROTOCOL,
      mode: CLOUD_DISPLAY_MODE,
      interestId: 'test_only_cloud_12345678901234',
      recipe: first,
      state: 'queued',
      retryAfterMs: 500,
    }
    expect(await parseCloudDisplayReply(reply, design)).toEqual(reply)
    await expect(
      parseCloudDisplayReply({ ...reply, recipe: { ...first, recipeDigest: other } }, design),
    ).rejects.toThrow()
    await expect(
      parseCloudDisplayReply(reply, design, {
        interestId: 'other_test_cloud_12345678901234',
        recipe: first,
      }),
    ).rejects.toThrow()
  })
  it('does not equate declared configuration or termination request with observation', () => {
    expect(
      cloudObservationSchema.safeParse({ state: 'unobserved', evidenceDigest: null }).success,
    ).toBe(true)
    expect(
      cloudObservationSchema.safeParse({ state: 'observed', evidenceDigest: null }).success,
    ).toBe(false)
    expect(
      cloudObservationSchema.safeParse({ state: 'unobserved', evidenceDigest: digest }).success,
    ).toBe(false)
    expect(CLOUD_DISPLAY_BUILD_GATE.dispatchAllowed).toBe(false)
    expect(localDisplayPermitSchema.safeParse({ paidExecutionAllowed: true }).success).toBe(false)
  })
  it('is DEV-only, explicitly selected and cannot replace the existing local/default mode', () => {
    const query = '?prototype=images&imageMode=private-cloud-display'
    expect(isCloudDisplaySelection(true, query)).toBe(true)
    expect(isCloudDisplaySelection(false, query)).toBe(false)
    expect(isCloudDisplaySelection(true, query + '&imageMode=private-display')).toBe(false)
    expect(isCloudDisplaySelection(true, '?prototype=images&imageMode=private-display')).toBe(false)
    expect(isCloudDisplaySelection(true, '')).toBe(false)
  })
})

// @vitest-environment jsdom
import { act, StrictMode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { webcrypto } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ImageConfigurator } from './ImageConfigurator'
import { defaultDesign, type DesignEnvelope } from '../domain/design'
import { displayHolds } from '../display/contract'
import {
  bindCloudRecipe,
  CLOUD_DISPLAY_LABEL,
  CLOUD_DISPLAY_PROTOCOL,
  CLOUD_DISPLAY_MODE,
  CLOUD_DISPLAY_REQUEST_PATH,
  cloudDisplayImagePath,
  type CloudDisplayReadyReply,
} from '../display/cloudContract'

function response(url: string, body: unknown, status = 200, png = false) {
  const result = new Response(png ? new Uint8Array(body as Uint8Array) : JSON.stringify(body), {
    status,
    headers: { 'content-type': png ? 'image/png' : 'application/json' },
  })
  Object.defineProperty(result, 'url', { value: url })
  return result
}

describe('cloud image-first journey (jsdom/inert replies; no browser, renderer or image evidence)', () => {
  let root: Root, host: HTMLDivElement
  beforeEach(() => {
    vi.useFakeTimers()
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
    vi.stubGlobal('crypto', webcrypto)
    vi.stubGlobal(
      'fetch',
      vi.fn<typeof fetch>(() => new Promise(() => undefined)),
    )
    Object.defineProperty(HTMLDialogElement.prototype, 'showModal', {
      configurable: true,
      value: function (this: HTMLDialogElement) {
        this.setAttribute('open', '')
      },
    })
    Object.defineProperty(HTMLDialogElement.prototype, 'close', {
      configurable: true,
      value: function (this: HTMLDialogElement) {
        this.removeAttribute('open')
      },
    })
    localStorage.clear()
    window.history.replaceState(null, '', '/?prototype=images&imageMode=private-cloud-display')
    host = document.createElement('div')
    document.body.append(host)
    root = createRoot(host)
  })
  afterEach(() => {
    act(() => root.unmount())
    host.remove()
    vi.useRealTimers()
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })
  const mount = () =>
    act(() =>
      root.render(
        <StrictMode>
          <ImageConfigurator />
        </StrictMode>,
      ),
    )
  function button(text: string) {
    const found = [...host.querySelectorAll('button')].find(
      (b) => b.textContent?.trim() === text || b.getAttribute('aria-label') === text,
    )
    if (!found) throw new Error(`Missing button: ${text}`)
    return found
  }
  const click = (text: string) => act(() => button(text).click())
  it('uses only the fixed cloud endpoint; keeps B controls and honest unconfigured state without substitution', async () => {
    vi.mocked(fetch).mockImplementation(async (url) =>
      response(
        String(url),
        {
          protocol: CLOUD_DISPLAY_PROTOCOL,
          error: {
            code: 'execution-denied',
            blocker: 'not-configured',
            message: 'Unavailable',
            retryable: false,
          },
        },
        503,
      ),
    )
    const write = vi.spyOn(Storage.prototype, 'setItem')
    mount()
    expect(host.querySelector('.brand')?.textContent).toContain('FURY')
    expect(host.querySelectorAll('[role=tab]')).toHaveLength(4)
    expect(host.querySelectorAll('[aria-label="Seven draft cameras"] button')).toHaveLength(7)
    expect(host.querySelector('img, canvas')).toBeNull()
    expect(host.textContent).toContain('Private cloud display pending')
    expect(host.textContent).toContain('Ultra')
    expect(write).not.toHaveBeenCalled()
    await act(async () => vi.advanceTimersByTimeAsync(250))
    expect(host.textContent).toContain('not-configured')
    expect(fetch).toHaveBeenCalledOnce()
    const [url, options] = vi.mocked(fetch).mock.calls[0]
    expect(String(url)).toBe(window.location.origin + CLOUD_DISPLAY_REQUEST_PATH)
    expect(JSON.parse(String(options?.body))).toEqual({
      protocol: CLOUD_DISPLAY_PROTOCOL,
      design: defaultDesign(),
    })
    expect(host.querySelector('img, canvas')).toBeNull()
    expect(button('Explore in 360°').disabled).toBe(true)
    expect(button('Display candidate export unavailable').disabled).toBe(true)
    expect(host.textContent).not.toContain('View mock preview')
    click('Image status & limits')
    expect(host.querySelector('dialog[open]')?.textContent).toContain(
      'Cloud execution is held in this build',
    )
    expect(host.querySelector('dialog[open]')?.textContent).toContain(
      'Cache hits are not render jobs',
    )
    expect(host.querySelector('dialog[open]')?.textContent).toContain(
      'external-private-three-display',
    )
    expect(host.querySelector('dialog[open]')?.textContent).not.toContain(
      'separately provisioned local operator permit',
    )
    expect(button('Strict image / PDF export').disabled).toBe(true)
    click('Close dialog')
    click('Container Gym')
    click('Apply draft changes')
    expect(host.textContent).toContain('Your Container Gym')
    expect(host.querySelector('img, canvas')).toBeNull()
    await act(async () => vi.advanceTimersByTimeAsync(200))
    const designs = vi
      .mocked(fetch)
      .mock.calls.map(([, opts]) => JSON.parse(String(opts?.body)).design as DesignEnvelope)
    expect(designs.at(-1)?.config.product.family).toBe('container')
    expect(host.querySelectorAll('[role=tab]')).toHaveLength(4)
  })
  it('renders only a validated current cloud candidate, exposes distinct recipe/proof and hides it on new selection', async () => {
    // Incomplete header + decode double exercises UI plumbing only, not GPU output or visual quality.
    const hash = `sha256:${'a'.repeat(64)}`
    const design = defaultDesign(),
      interestId = 'synthetic-cloud-ui-interest-001'
    const recipe = await bindCloudRecipe(
      design,
      {
        sourceManifestDigest: hash,
        assetManifestDigest: hash,
        bundleDigest: hash,
        lockfileDigest: hash,
        runtimePolicyDigest: hash,
        threeRevision: '186',
      },
      hash,
      hash,
    )
    const bytes = new Uint8Array(44)
    bytes.set([137, 80, 78, 71, 13, 10, 26, 10])
    const view = new DataView(bytes.buffer)
    view.setUint32(8, 13)
    view.setUint32(12, 0x49484452)
    view.setUint32(16, recipe.binding.profile.width)
    view.setUint32(20, recipe.binding.profile.height)
    const checksum = `sha256:${Buffer.from(await webcrypto.subtle.digest('SHA-256', bytes)).toString('hex')}`
    const reply: CloudDisplayReadyReply = {
      protocol: CLOUD_DISPLAY_PROTOCOL,
      mode: CLOUD_DISPLAY_MODE,
      state: 'ready',
      interestId,
      recipe,
      artifact: {
        checksum,
        receiptDigest: hash,
        mediaType: 'image/png',
        byteLength: bytes.length,
        width: recipe.binding.profile.width,
        height: recipe.binding.profile.height,
        src: cloudDisplayImagePath(interestId, checksum),
        exactMatch: true,
        approvedCurrentImage: false,
        cacheStatus: 'verified-exact-hit',
        provenance: {
          kind: 'external-private-three-display',
          label: CLOUD_DISPLAY_LABEL,
          sessionId: 'synthetic-cloud-ui-session-001',
          revision: 1,
          proofDigest: hash,
          qualified: false,
          productionAllowed: false,
          strictReference: false,
          visualParityClaimed: false,
          holds: displayHolds(design),
        },
      },
    }
    vi.stubGlobal(
      'createImageBitmap',
      vi.fn(async () => ({
        width: reply.artifact.width,
        height: reply.artifact.height,
        close: vi.fn(),
      })),
    )
    const revoke = vi.fn()
    Object.defineProperty(URL, 'createObjectURL', {
      configurable: true,
      value: vi.fn(() => 'blob:inert-ui-cloud'),
    })
    Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: revoke })
    vi.mocked(fetch).mockImplementation(async (url) =>
      response(
        String(url),
        String(url).endsWith('.png') ? bytes : reply,
        200,
        String(url).endsWith('.png'),
      ),
    )
    mount()
    await act(async () =>
      vi.waitFor(() => expect(URL.createObjectURL).toHaveBeenCalledOnce(), { timeout: 3000 }),
    )
    expect(host.querySelector('img')?.getAttribute('src')).toBe('blob:inert-ui-cloud')
    expect(host.querySelector('figure')?.getAttribute('data-image-state')).toBe(
      'current-cloud-display-unqualified',
    )
    expect(host.textContent).toContain('cache hit, not a render job')
    expect(host.textContent).toContain('visual quality is not approved')
    click('Image status & limits')
    expect(host.querySelector('dialog')?.textContent).toContain(recipe.recipeDigest)
    expect(host.querySelector('dialog')?.textContent).toContain('proofDigest')
    expect(host.querySelector('dialog')?.textContent).toContain('external-private-three-display')
    click('Close dialog')
    vi.mocked(fetch).mockImplementation(async () => new Promise(() => undefined))
    click('Container Gym')
    click('Apply draft changes')
    expect(host.querySelector('img')).toBeNull()
    expect(host.textContent).toContain('Previous display image hidden; not this configuration')
    await act(async () => Promise.resolve())
    expect(revoke).toHaveBeenCalledWith('blob:inert-ui-cloud')
  })
})

import { TEXTURE_SETS, loadedMaps, type TextureSet } from '../../materials'

const paths = new Map<string, TextureSet>()
for (const [set, info] of Object.entries(TEXTURE_SETS))
  for (const channel of 'detailOnly' in info ? ['normal', 'arm'] : ['albedo', 'normal', 'arm'])
    paths.set(`/textures/${set}/${channel}.webp`, set as TextureSet)

/** Session-scoped asset tracker: no revision-1 worker assumption or timer monkey-patching.
 * Requests must fully finish before revision publication. A failed request poisons the realm;
 * library retries can never turn that failure back into ready. Host independently hashes bytes. */
export function observeDisplayResources() {
  const original = window.fetch
  const fetchNative = original.bind(window)
  const abort = new AbortController()
  const requested = new Set<TextureSet>()
  let pending = 0,
    total = 0,
    calls = 0,
    failure: unknown,
    closed = false
  const check = () => {
    if (closed || failure) throw new Error('Private display resource failure.', { cause: failure })
  }
  window.fetch = async (input, init) => {
    check()
    const path = typeof input === 'string' ? input : input instanceof URL ? input.href : ''
    const url = new URL(path, location.origin)
    if (
      init !== undefined ||
      url.origin !== location.origin ||
      url.search ||
      url.hash ||
      !paths.has(url.pathname) ||
      (path !== url.href && path !== url.pathname) ||
      /[%\\]/.test(path)
    ) {
      failure = new Error('Unlisted private resource.')
      check()
    }
    if (++calls > 512) {
      failure = new Error('Private resource request cap.')
      check()
    }
    requested.add(paths.get(url.pathname)!)
    pending++
    try {
      const response = await fetchNative(url.href, {
        redirect: 'error',
        credentials: 'omit',
        cache: 'no-store',
        signal: abort.signal,
      })
      check()
      if (
        response.status !== 200 ||
        response.redirected ||
        response.url !== url.href ||
        response.headers.get('content-type')?.split(';')[0] !== 'image/webp' ||
        !response.body
      )
        throw new Error('Private texture response rejected.')
      const reader = response.body.getReader()
      const chunks: Uint8Array<ArrayBuffer>[] = []
      let bytes = 0
      try {
        for (;;) {
          const item = await reader.read()
          check()
          if (item.done) break
          bytes += item.value.length
          total += item.value.length
          if (bytes > 16 * 1024 * 1024 || total > 128 * 1024 * 1024)
            throw new Error('Texture bytes exceeded.')
          chunks.push(new Uint8Array(item.value))
        }
      } finally {
        await reader.cancel().catch(() => {})
        reader.releaseLock()
      }
      if (!bytes) throw new Error('Empty texture.')
      return new Response(new Blob(chunks, { type: 'image/webp' }), { status: 200 })
    } catch (error) {
      failure = error
      throw error
    } finally {
      pending--
    }
  }
  return {
    check,
    ready() {
      check()
      return pending === 0 && requested.size > 0 && [...requested].every((set) => !!loadedMaps(set))
    },
    close() {
      closed = true
      abort.abort()
      window.fetch = original
    },
  }
}

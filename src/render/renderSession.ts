/**
 * This page's render session and its warm-up call. Free of three.js imports, so the app shell can
 * ask the cloud to start the visitor's GPU before the scene chunk has loaded.
 */

const SESSION_KEY = 'fury-render-session'
/** What the gateway accepts as a session name (render-server/fury_render/gateway.py). */
const SESSION_FORM = /^[A-Za-z0-9_-]{8,64}$/

type SessionStore = Pick<Storage, 'getItem' | 'setItem'>

function storageOf(): SessionStore | null {
  try {
    return globalThis.localStorage ?? null
  } catch {
    // Reaching for storage itself throws in some embedded and private contexts.
    return null
  }
}

/**
 * The session's name, kept in local storage: a reload comes back to the visitor's container,
 * probably still warm, instead of taking a second place under the gateway's cap. Storage that is
 * missing, full, or forbidden (private mode) still gets a name, for this page alone.
 */
export function renderSession(storage: SessionStore | null = storageOf()): string {
  try {
    const kept = storage?.getItem(SESSION_KEY)
    if (kept && SESSION_FORM.test(kept)) return kept
  } catch {
    // Read as if nothing were kept.
  }
  const fresh =
    globalThis.crypto?.randomUUID?.().replaceAll('-', '') ??
    `${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`
  try {
    storage?.setItem(SESSION_KEY, fresh)
  } catch {
    // Not kept: the next page load starts a session of its own.
  }
  return fresh
}

/**
 * This page's render session. The gateway gives each session a GPU of its own
 * (render-server/modal_app.py), so every request from the page, render or upload, names it. A query
 * parameter rather than a header: no CORS preflight depends on it, so a page works against a
 * gateway from before sessions too.
 */
export const RENDER_SESSION = renderSession()

/** What the gateway answered the warm-up with, for the bench: which renderer the session gets. */
export const warmth: { asked: boolean; status: number; renderer: string } = {
  asked: false,
  status: 0,
  renderer: '',
}

let warmed = false

/**
 * Asks the gateway to start the session's GPU (GET /warm), once per page and without waiting for
 * the answer, so the container boots while the scene chunk and the scanned textures stream in. A
 * failure is nothing to report: the renders find out for themselves.
 */
export function warmCloud(url: string) {
  if (warmed) return
  warmed = true
  warmth.asked = true
  fetch(`${url}/warm?session=${RENDER_SESSION}`)
    .then(async (response) => {
      warmth.status = response.status
      const answer = (await response.json().catch(() => null)) as { renderer?: string } | null
      warmth.renderer = answer?.renderer ?? response.headers.get('x-fury-renderer') ?? ''
    })
    .catch(() => {})
}

/**
 * Path-tracing settings read from the address and the build, free of three.js imports so the app
 * shell can read them before the 3D chunk has loaded. (The gallery's progress is in
 * stillStatus.ts.)
 */

/** Where a path tracer is with an image. */
export type TraceState = 'off' | 'preparing' | 'tracing' | 'converged'

/** `?trace=0` or `?trace=1` overrides the default, which follows the device's quality tier. */
export function requestedTrace(search = window.location.search): boolean | null {
  const value = new URLSearchParams(search).get('trace')
  return value === '1' || value === 'on' ? true : value === '0' || value === 'off' ? false : null
}

/**
 * A render server on this machine, as `?cloud=` may name one: http://localhost or 127.0.0.1, at
 * any port and path (the bake script's proxy is at a path of its own page), without its last
 * slash; null for anything else.
 */
export function loopbackCloud(param: string | null): string | null {
  if (!param || !/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?(\/[\w.~-]+)*\/?$/.test(param))
    return null
  return param.replace(/\/$/, '')
}

/**
 * The cloud render server's address: VITE_CLOUD_RENDER_URL at build time. `?cloud=0` turns it
 * off, and `?cloud=<url>` points at a local server for development (this machine only).
 */
export function cloudUrl(search = window.location.search): string | null {
  const param = new URLSearchParams(search).get('cloud')
  if (param === '0' || param === 'off') return null
  const local = loopbackCloud(param)
  if (local) return local
  const configured = import.meta.env.VITE_CLOUD_RENDER_URL as string | undefined
  return configured ? configured.replace(/\/$/, '') : null
}

import { useEffect, useRef } from 'react'

/** Minimum time between address-bar updates while the design changes. */
export const FRAGMENT_INTERVAL_MS = 500

type Fragment = { value: string; written: string | null; last: number }

function write(fragment: Fragment) {
  if (fragment.written === fragment.value) return
  fragment.last = performance.now()
  try {
    window.history.replaceState(
      null,
      '',
      `${window.location.pathname}${window.location.search}#c=${fragment.value}`,
    )
    fragment.written = fragment.value
  } catch {
    /* Rate-limited: the next change, or leaving the page, writes it. */
  }
}

/**
 * Keeps the share fragment (#c=…) in the address bar current. Browsers rate-limit history updates
 * (Safari throws after 100 in 30 seconds, easily reached by dragging a slider), so it is written at
 * most twice a second, flushed when the page is hidden or closed, and can never throw.
 *
 * A fragment the user navigates to (a share link pasted into this tab) is passed to `onOpen`
 * rather than silently overwritten by the next edit. If `onOpen` rejects it, the address bar goes
 * back to the design on screen, so a reload does not swap it for an unreadable link.
 */
export function useShareFragment(encoded: string, onOpen: (value: string) => boolean) {
  const fragment = useRef<Fragment>({ value: encoded, written: null, last: -Infinity })
  const open = useRef(onOpen)
  useEffect(() => {
    open.current = onOpen
  }, [onOpen])
  useEffect(() => {
    const current = fragment.current
    current.value = encoded
    const wait = FRAGMENT_INTERVAL_MS - (performance.now() - current.last)
    if (wait <= 0) return write(current)
    const timer = setTimeout(() => write(current), wait)
    return () => clearTimeout(timer)
  }, [encoded])
  useEffect(() => {
    const current = fragment.current
    const flush = () => write(current)
    const hidden = () => {
      if (document.visibilityState === 'hidden') flush()
    }
    // replaceState never fires hashchange, so this is the user's own navigation. Fragments without
    // a design (the skip link's #configuration) are left alone.
    const navigated = () => {
      // URLSearchParams reads '+', which the encoding uses, as a space.
      const value = new URLSearchParams(window.location.hash.slice(1)).get('c')?.replace(/ /g, '+')
      if (value === undefined || value === current.value) return
      current.written = null
      if (!open.current(value)) write(current)
    }
    window.addEventListener('pagehide', flush)
    document.addEventListener('visibilitychange', hidden)
    window.addEventListener('hashchange', navigated)
    return () => {
      // Unmounting (an error screen replacing the app) must not drop the latest design.
      flush()
      window.removeEventListener('pagehide', flush)
      document.removeEventListener('visibilitychange', hidden)
      window.removeEventListener('hashchange', navigated)
    }
  }, [])
}

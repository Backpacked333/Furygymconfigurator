/**
 * Starts downloading the 360° view (its scene, renderer, and tracer) when the visitor points at,
 * focuses, or touches its button: the click that follows then finds most of it loaded. With the
 * design shown, its scans start downloading too (liveWarmup.ts), so the view's wait for them
 * before it refines is shorter. Plain gallery browsing still loads none of it: nothing is
 * imported here but on intent.
 */
export function prefetchLiveView(design?: unknown) {
  void import('./LiveDesignScene').catch(() => {})
  if (design !== undefined)
    void import('./liveWarmup').then((warmup) => warmup.warmLiveDesign(design)).catch(() => {})
}

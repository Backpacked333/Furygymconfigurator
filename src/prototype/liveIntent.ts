/**
 * Starts downloading the 360° view (its scene, renderer, and tracer) when the visitor points at,
 * focuses, or touches its button: the click that follows then finds most of it loaded. Plain
 * gallery browsing still loads none of it.
 */
export function prefetchLiveView() {
  void import('./LiveDesignScene').catch(() => {})
}

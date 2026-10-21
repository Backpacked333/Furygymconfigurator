/** Budget submitted batches, not quality. An already-submitted GPU batch cannot be cancelled. */
export function nextTracePasses(
  current: number,
  elapsedMs: number,
  budgetMs: number,
  maximum: number,
) {
  if (!Number.isFinite(elapsedMs) || elapsedMs <= 0) return current
  const estimate = Math.floor((current * budgetMs) / elapsedMs)
  return Math.max(1, Math.min(maximum, Math.ceil(current * 1.5), estimate))
}

/**
 * `nextTracePasses` for a batch whose measured time includes a completion latency of its own:
 * `onSubmittedWorkDone` resolves a frame or so after the GPU finishes on some platforms (Chrome on
 * Metal), so even a one-pass batch reads as over a 12 ms budget and the batch never grows.
 * `floorMs` is the smallest time a one-pass batch has taken: that latency and one pass. Only the
 * time beyond it is the other passes' work, and that is what the budget sizes.
 */
export function nextTracePassesOverLatency(
  current: number,
  elapsedMs: number,
  floorMs: number,
  budgetMs: number,
  maximum: number,
) {
  if (!Number.isFinite(elapsedMs) || elapsedMs <= 0 || !Number.isFinite(floorMs))
    return nextTracePasses(current, elapsedMs, budgetMs, maximum)
  const work = Math.max(0, elapsedMs - floorMs)
  const perPass = current > 1 ? work / (current - 1) : 0
  const estimate = perPass > 0 ? Math.floor(budgetMs / perPass) : maximum
  return Math.max(1, Math.min(maximum, Math.ceil(current * 1.5), estimate))
}

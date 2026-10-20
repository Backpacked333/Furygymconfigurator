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

/** The cube face size PMREM actually allocates for a requested size (a power of two). */
export const cubeSize = (size: number) => 2 ** Math.floor(Math.log2(size))

/**
 * Whether a PMREM target can take a capture of `size`: same cube, same allocation. Comparing with
 * the requested size instead (192 allocates 128) reallocated the targets on every capture.
 */
export const reusable = (target: { height: number } | null, size: number) =>
  !!target && target.height === 4 * cubeSize(size)

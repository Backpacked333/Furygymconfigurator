import type { OutputChunk } from 'rollup'

/** Follow static chunk imports only; a user-triggered dynamic entry is not initial JS. */
export function eagerChunks(chunks: OutputChunk[], entries = chunks.filter((c) => c.isEntry)) {
  const visited = new Set<OutputChunk>()
  const byName = new Map(chunks.map((c) => [c.fileName, c]))
  function visit(chunk: OutputChunk) {
    if (visited.has(chunk)) return
    visited.add(chunk)
    for (const name of chunk.imports) {
      const next = byName.get(name)
      if (next) visit(next)
    }
  }
  for (const entry of entries) visit(entry)
  return [...visited]
}

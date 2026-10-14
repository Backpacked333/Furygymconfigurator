import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'
import provenance from './provenance.json'

const sha256 = (data: Uint8Array) => createHash('sha256').update(data).digest('hex')

describe('Q11 pinned offline experiment inputs', () => {
  it('uses the actual checked-in hero and background WebP bytes', async () => {
    for (const spec of provenance.textures)
      for (const [map, hash] of Object.entries(spec.maps)) {
        const source = new URL(`../../../public/textures/${spec.set}/${map}.webp`, import.meta.url)
        expect(sha256(await readFile(source))).toBe(hash)
      }
  })

  it('pins the installed Three decoder/version rather than a mutable CDN', async () => {
    const base = new URL('../../../node_modules/three/', import.meta.url)
    const installed = JSON.parse(await readFile(new URL('package.json', base), 'utf8'))
    expect(installed.version).toBe(provenance.decoder.version)
    for (const [extension, hash] of [
      ['js', provenance.decoder.jsSha256],
      ['wasm', provenance.decoder.wasmSha256],
    ])
      expect(
        sha256(
          await readFile(new URL(`examples/jsm/libs/basis/basis_transcoder.${extension}`, base)),
        ),
      ).toBe(hash)
  })

  it('contains six uniquely identified reproducible outputs without a blanket adoption claim', () => {
    const outputs = provenance.textureOutputExpectations
    expect(new Set(outputs.map((o) => `${o.set}/${o.map}`)).size).toBe(6)
    expect(outputs.reduce((sum, o) => sum + o.bytes, 0)).toBe(3516999)
    outputs.forEach((o) => expect(o.sha256).toMatch(/^[a-f0-9]{64}$/))
    expect(provenance.model.decision).toMatch(/^Reject/)
    expect(provenance.model.origin).toContain('procedural')
  })
})

// @vitest-environment node
import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { HISTORICAL_REFERENCE } from './ImageConfigurator'
import { renderVersion } from '../../scripts/render-version'
import type { StillsManifest } from '../lib/stillsManifest'

const root = new URL('../../', import.meta.url)
describe('historical aesthetic reference provenance', () => {
  it('pins an existing historical derivative and its real master hash, never the current renderer identity', () => {
    const manifest = JSON.parse(
      readFileSync(new URL('src/stills.manifest.json', root), 'utf8'),
    ) as StillsManifest
    const reference = HISTORICAL_REFERENCE
    expect(manifest.version).toBe(reference.revision)
    const [hash, width] = manifest.stills[reference.design][`${reference.view}|wide`]
    expect(reference.src).toBe(
      `${manifest.base}/${reference.design}/${reference.view}-wide-1600.${hash}.webp`,
    )
    expect(existsSync(new URL(`public${reference.src}`, root))).toBe(true)
    const master = readFileSync(
      new URL(
        `public${manifest.base}/${reference.design}/${reference.view}-wide-${width}.${hash}.webp`,
        root,
      ),
    )
    expect(createHash('sha256').update(master).digest('hex').slice(0, 8)).toBe(hash)
    expect(renderVersion(fileURLToPath(root))).not.toBe(reference.revision)
  })
})

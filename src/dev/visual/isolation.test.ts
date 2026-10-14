import { readdir, readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { extname, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

describe('development fixture isolation', () => {
  it('has no customer source imports from the development-only subtree', async () => {
    const root = fileURLToPath(new URL('../../', import.meta.url))
    const offenders: string[] = []
    async function scan(directory: string) {
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        const path = resolve(directory, entry.name)
        if (entry.isDirectory() && entry.name !== 'dev') await scan(path)
        else if (
          entry.isFile() &&
          ['.ts', '.tsx', '.js', '.jsx'].includes(extname(path)) &&
          !/\.test\./.test(path)
        ) {
          const source = await readFile(path, 'utf8')
          if (/(?:from\s*|import\s*\(?\s*)['"][^'"]*(?:\/dev\/|dev\/visual)/.test(source))
            offenders.push(path)
        }
      }
    }
    await scan(root)
    expect(offenders).toEqual([])
  })
})

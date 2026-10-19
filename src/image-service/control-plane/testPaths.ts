import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll } from 'vitest'

export const REPO_ROOT = resolve(fileURLToPath(new URL('../../../', import.meta.url)))
export const TEST_ROOT = mkdtempSync(join(tmpdir(), 'fury-control-plane-'))
afterAll(() => rmSync(TEST_ROOT, { recursive: true, force: true }))

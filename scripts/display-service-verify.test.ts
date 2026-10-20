import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { parseDisplayServiceVerifyArgs } from './display-service-verify'

describe('service verify-only command boundary', () => {
  it('has no capture/render/provider/permit generation command', () => {
    for (const args of [
      [],
      ['--render'],
      ['--verify-only', '--permit', 'x'],
      ['--verify-only', '--output', '/tmp/out.json'],
      ['--verify-only', '--output', '/home/ubuntu/Documents/fury-display-handoff/../out.json'],
    ])
      expect(() => parseDisplayServiceVerifyArgs(args)).toThrow()
    expect(parseDisplayServiceVerifyArgs(['--verify-only'])).toBeUndefined()
  })
  it('production factory has the actual fixed backend connection and verifier requests no open', () => {
    const factory = readFileSync(
      new URL('../src/image-service/display/production.ts', import.meta.url),
      'utf8',
    )
    expect(factory).toContain("import('../../render/display/backend')")
    expect(factory).toContain('createPrivateDisplayBackend()')
    const cli = readFileSync(new URL('./display-service-verify.ts', import.meta.url), 'utf8')
    expect(cli).toContain('createProductionDisplayService(undefined, true)')
    expect(cli).not.toMatch(/\.open\(|\.render\(|runCapture\(|spawn\(/)
    expect(cli).toContain("denial !== 'execution-denied'")
  })
})

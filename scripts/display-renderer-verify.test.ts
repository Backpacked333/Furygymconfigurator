import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { parseRendererVerifyArgs } from './display-renderer-verify'

describe('renderer verification is explicit and render-free', () => {
  it('accepts only verify-only and a new renderer evidence path in this handoff', () => {
    const output = '/home/ubuntu/Documents/fury-display-handoff/renderer-verify-test.json'
    expect(parseRendererVerifyArgs(['--verify-only', '--output', output])).toBe(output)
    for (const args of [
      [],
      ['--render', '--output', output],
      ['--verify-only'],
      ['--verify-only', '--output', './report.json'],
      [
        '--verify-only',
        '--output',
        '/home/ubuntu/Documents/fury-display-handoff/operator-display-permit.json',
      ],
      ['--verify-only', '--output', '/tmp/renderer-test.json'],
      ['--verify-only', '--output', output, '--open'],
    ])
      expect(() => parseRendererVerifyArgs(args)).toThrow()
  })
  it('verification imports the compiler and CPU plans, never the browser/driver factory or renderer', () => {
    const source = readFileSync(new URL('./display-renderer-verify.ts', import.meta.url), 'utf8')
    expect(source).toContain('prepareDisplayBuild()')
    expect(source).toContain('prepared.revalidate()')
    expect(source).toMatch(/open\(output,\s*'wx',\s*0o600\)/)
    expect(source).not.toMatch(
      /createPrivateDisplayBackend|openDisplayProcess|createDisplayScene|\.render\(|document\.createElement|operator-display-permit/,
    )
    expect(source).toMatch(/renderCalls:\s*0/)
    expect(source).toMatch(/browserStarts:\s*0/)
    expect(source).toMatch(/qualified:\s*false/)
  })
})

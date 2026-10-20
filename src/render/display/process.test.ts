import { describe, expect, it, vi } from 'vitest'
import { PassThrough } from 'node:stream'
import { readFileSync } from 'node:fs'
import {
  DisplayPipe,
  displayExpression,
  validateHostHardware,
  validateObservedBrowserVersion,
} from './process'

describe('owned process protocol (no process or browser launched)', () => {
  it('uses bounded CDP pipes and rejects remote protocol errors/late replies', async () => {
    const input = new PassThrough(),
      output = new PassThrough(),
      fail = vi.fn()
    const pipe = new DisplayPipe(input, output, fail)
    const call = pipe.send('Browser.getVersion')
    output.write(Buffer.from('{"id":1,"result":{"product":"Chrome/1"}}\0'))
    expect(await call).toEqual({ product: 'Chrome/1' })
    const error = pipe.send('Runtime.evaluate')
    output.write(Buffer.from('{"id":2,"error":{"message":"bad"}}\0'))
    await expect(error).rejects.toThrow('failed')
    pipe.close()
    await expect(pipe.send('x')).rejects.toThrow('closed')
  })
  it('malformed pipe data and overlarge commands fail without reflection/eval ingress', async () => {
    const input = new PassThrough(),
      output = new PassThrough(),
      fail = vi.fn()
    const pipe = new DisplayPipe(input, output, fail)
    await expect(pipe.send('Runtime.evaluate', { expression: 'x'.repeat(65537) })).rejects.toThrow(
      'bound',
    )
    output.write(Buffer.from('garbage\0'))
    expect(fail).toHaveBeenCalledOnce()
    expect(displayExpression('ready')).toBe('globalThis.__FURY_PRIVATE_DISPLAY__.ready()')
  })
  it('requires positive matching hardware evidence; software/unknown cannot claim hardware', () => {
    expect(() =>
      validateHostHardware(
        { gpu: { devices: [{ vendorId: 4318, deviceId: 123 }] } },
        'NVIDIA test-only 0x007b',
      ),
    ).not.toThrow()
    for (const data of [
      {},
      { gpu: { devices: [{ vendorId: 123, deviceId: 1 }] } },
      { gpu: { devices: [{ vendorId: 4318, deviceId: 1, deviceString: 'SwiftShader' }] } },
    ])
      expect(() => validateHostHardware(data, 'NVIDIA test-only')).toThrow()
    expect(() =>
      validateHostHardware(
        { gpu: { devices: [{ vendorId: 4318, deviceId: 1 }] } },
        'Intel test-only',
      ),
    ).toThrow('mismatch')
    expect(() =>
      validateHostHardware(
        { gpu: { devices: [{ vendorId: 4318, deviceId: 123 }] } },
        'NVIDIA vendor-only',
      ),
    ).toThrow('mismatch')
    expect(() =>
      validateHostHardware(
        { gpu: { devices: [{ vendorId: 4318, deviceId: 123 }] } },
        'NVIDIA different 0x007c',
      ),
    ).toThrow('mismatch')
  })
  it('matches observed page/CDP browser versions, allowing only Chrome’s standard UA reduction', () => {
    expect(() =>
      validateObservedBrowserVersion(
        'HeadlessChrome/137.0.0.0',
        'Chrome/137.0.7118.2',
        'Mozilla/5.0 HeadlessChrome/137.0.0.0 Safari/537.36',
      ),
    ).not.toThrow()
    expect(() =>
      validateObservedBrowserVersion(
        'Chrome/137.0.7118.2',
        'Chrome/137.0.7118.2',
        'Chrome/137.0.7118.2',
      ),
    ).not.toThrow()
    expect(() =>
      validateObservedBrowserVersion(
        'HeadlessChrome/137.0.0.0',
        'Chrome/138.0.7118.2',
        'HeadlessChrome/137.0.0.0',
      ),
    ).toThrow()
    expect(() =>
      validateObservedBrowserVersion('Chrome/137.0.1.0', 'Chrome/137.0.7118.2', 'Chrome/137.0.1.0'),
    ).toThrow()
    expect(() =>
      validateObservedBrowserVersion(
        'Chrome/137.0.0.0',
        'Chrome/137.0.7118.2',
        'Chrome/137.0.7118.2',
      ),
    ).toThrow()
  })
  it('independent supervisor pins executable, owns pidfds, and observes parent identity/EOF and total/idle/job bounds', () => {
    const source = readFileSync(new URL('./supervisor.py', import.meta.url), 'utf8')
    const normalized = source.replace(/\s+/g, ' ')
    for (const evidence of [
      'parent_identity(parent) != identity',
      'os.getppid() != parent',
      'if not data:',
      'total_deadline',
      'phase_deadline',
      "180 if phase == 'job' else 30",
      'signal_descendants(signal.SIGTERM)',
      'signal_descendants(signal.SIGKILL)',
      'child.wait(timeout=2)',
      'descendants(os.getpid())',
      'exit-observed',
      'start_new_session=True',
      'pass_fds=(3, 4)',
    ])
      expect(normalized).toContain(evidence)
    // Actual ownership/PID-race behavior is additionally exercised by test_supervisor.py
    // with inert /proc and pidfd doubles. Never weaken this to permit numeric signals.
    expect(source).toMatch(
      /fd\s*=\s*os\.pidfd_open\(pid,\s*0\)[\s\S]*parent_identity\(pid\)\s*==\s*identity[\s\S]*signal\.pidfd_send_signal\(fd,\s*signum\)/,
    )
    expect(source).toMatch(/os\.close\(fd\)/)
    expect(source).toMatch(/signal\.pidfd_send_signal\(self_fd,\s*0\)/)
    expect(source).not.toMatch(
      /os\.kill(?:pg)?\s*\(|shell\s*=\s*True|swiftshader|no-sandbox|disable-gpu-watchdog/,
    )
  })
})

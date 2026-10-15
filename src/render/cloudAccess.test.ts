import { afterEach, describe, expect, it, vi } from 'vitest'
import { cloudAuthorization, lockCloud, unlockCloud } from './cloudAccess'

afterEach(() => {
  lockCloud()
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

describe('cloud access', () => {
  it('sends the PIN only to auth and scopes the token to its gateway', async () => {
    const fetch = vi
      .fn()
      .mockResolvedValue(
        new Response(JSON.stringify({ token: 'session', expiresAt: Date.now() + 60000 })),
      )
    vi.stubGlobal('fetch', fetch)
    expect(cloudAuthorization('https://gpu.example')).toEqual({})
    await unlockCloud('https://gpu.example', 'test-pin')
    expect(fetch.mock.calls[0][0]).toBe('https://gpu.example/auth')
    expect(cloudAuthorization('https://gpu.example')).toEqual({ authorization: 'Bearer session' })
    expect(cloudAuthorization('https://other.example')).toEqual({})
    lockCloud()
    expect(cloudAuthorization('https://gpu.example')).toEqual({})
  })
  it('rejects incorrect PINs and expired responses', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('{}', { status: 401 })))
    await expect(unlockCloud('https://gpu.example', 'wrong')).rejects.toThrow('Incorrect PIN')
    expect(cloudAuthorization('https://gpu.example')).toEqual({})
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(new Response(JSON.stringify({ token: 'old', expiresAt: 1 }))),
    )
    await expect(unlockCloud('https://gpu.example', 'test-pin')).rejects.toThrow('Invalid')
  })
  it('expires access automatically', async () => {
    vi.useFakeTimers()
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(
          new Response(JSON.stringify({ token: 'session', expiresAt: Date.now() + 1000 })),
        ),
    )
    await unlockCloud('https://gpu.example', 'test-pin')
    vi.advanceTimersByTime(1001)
    expect(cloudAuthorization('https://gpu.example')).toEqual({})
  })
})

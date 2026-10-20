import { execFileSync } from 'node:child_process'
import { expect, it } from 'vitest'

const configured = {
  VERCEL: '1',
  RENDER_LIBRARY_SUPABASE_URL: 'https://storage.example.test',
  RENDER_LIBRARY_SERVICE_ROLE_KEY: 'server-only-test-secret',
  VITE_RENDER_LIBRARY_STORAGE_ORIGIN: 'https://storage.example.test',
}
const check = (env: Record<string, string>) =>
  execFileSync(process.execPath, ['scripts/check-library-env.mjs'], { env, stdio: 'pipe' })

it('allows offline local builds and configured read-only previews without enabling rendering', () => {
  expect(() => check({})).not.toThrow()
  expect(() => check(configured)).not.toThrow()
})
it.each(Object.keys(configured).filter((name) => name !== 'VERCEL'))(
  'blocks a deployment missing %s, including branches without inherited configuration',
  (name) => {
    expect(() => check({ ...configured, [name]: '' })).toThrow(name)
  },
)
it.each(['http://storage.example.test', 'https://storage.example.test/', 'not-a-url'])(
  'rejects an invalid storage origin without printing credentials: %s',
  (origin) => {
    try {
      check({ ...configured, RENDER_LIBRARY_SUPABASE_URL: origin })
      expect.fail('Build must fail')
    } catch (error) {
      expect(String(error)).toContain('RENDER_LIBRARY_SUPABASE_URL')
      expect(String(error)).not.toContain(configured.RENDER_LIBRARY_SERVICE_ROLE_KEY)
    }
  },
)
it('blocks mismatched API and browser storage origins', () => {
  expect(() =>
    check({ ...configured, VITE_RENDER_LIBRARY_STORAGE_ORIGIN: 'https://other.test' }),
  ).toThrow('must match')
})

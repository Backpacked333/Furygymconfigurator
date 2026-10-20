import { afterEach, expect, it, vi } from 'vitest'
import { CUSTOMER_CAMERA_REFS } from '../../views'
import { StaticSeedSource } from '../artifacts'
import { importSeedLibrary } from '../importSeed'
import { SupabaseTransport } from '../supabase'

afterEach(() => vi.restoreAllMocks())

it('imports the pinned historical library without treating legacy cameras as customer views', async () => {
  vi.spyOn(StaticSeedSource.prototype, 'images').mockResolvedValue([])
  const call = vi.spyOn(SupabaseTransport.prototype, 'call').mockResolvedValue(null)
  const result = await importSeedLibrary({
    RENDER_LIBRARY_ALLOW_SEED_IMPORT: 'import-pinned-400',
    RENDER_LIBRARY_PUBLIC_ORIGIN: 'https://app.example',
    RENDER_LIBRARY_SUPABASE_URL: 'https://storage.example',
    RENDER_LIBRARY_SERVICE_ROLE_KEY: 'test-only-not-a-real-service-key-12345',
  })
  expect(result).toEqual({ sets: 100, images: 0 })
  expect(call).toHaveBeenCalledTimes(100)
  for (const [name, args] of call.mock.calls) {
    expect(name).toBe('render_library_import_seed')
    const design = (args as { design: { presentation: { cameraRef: string } } }).design
    expect(CUSTOMER_CAMERA_REFS).toContain(design.presentation.cameraRef)
  }
})

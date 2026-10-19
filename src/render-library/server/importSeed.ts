import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { computeSetIdentity } from '../identity'
import { normalizeCustomerDesign } from '../views'
import { StaticSeedSource } from './artifacts'
import { verifySeedManifest } from './seedCache'
import { SupabaseTransport } from './supabase'

/** Operator-only import. No approval, job, outbox or GPU work is created. */
export async function importSeedLibrary(
  env: Record<string, string | undefined>,
  fetcher: typeof fetch = fetch,
) {
  if (
    env.RENDER_LIBRARY_ALLOW_SEED_IMPORT !== 'import-pinned-400' ||
    !env.RENDER_LIBRARY_PUBLIC_ORIGIN ||
    !env.RENDER_LIBRARY_SUPABASE_URL ||
    !env.RENDER_LIBRARY_SERVICE_ROLE_KEY
  )
    throw new Error('Explicit seed import configuration required')
  const manifestPath = join(process.cwd(), 'public/native-library/manifest.json')
  const manifest = verifySeedManifest(await readFile(manifestPath))
  const source = new StaticSeedSource(env.RENDER_LIBRARY_PUBLIC_ORIGIN, fetcher, manifestPath)
  const database = new SupabaseTransport(
    env.RENDER_LIBRARY_SUPABASE_URL,
    env.RENDER_LIBRARY_SERVICE_ROLE_KEY,
    fetcher,
  )
  const seen = new Set<string>()
  let imported = 0
  for (const entry of manifest.entries) {
    const design = normalizeCustomerDesign(entry.design)
    const identity = await computeSetIdentity(design)
    if (seen.has(identity.setKey)) continue
    const images = await source.images(design)
    await database.call('render_library_import_seed', { design, identity, images })
    seen.add(identity.setKey)
    imported += images.length
  }
  return { sets: seen.size, images: imported }
}

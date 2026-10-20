import { pathToFileURL } from 'node:url'

export function checkLibraryEnv(env) {
  if (env.VERCEL !== '1') return
  const required = [
    'RENDER_LIBRARY_SUPABASE_URL',
    'RENDER_LIBRARY_SERVICE_ROLE_KEY',
    'VITE_RENDER_LIBRARY_STORAGE_ORIGIN',
  ]
  const missing = required.filter((name) => !env[name]?.trim())
  if (missing.length)
    throw new Error(
      `Image library configuration missing: ${missing.join(', ')}. Configure this exact Vercel branch before deploying; preview variables do not follow merges.`,
    )
  for (const name of ['RENDER_LIBRARY_SUPABASE_URL', 'VITE_RENDER_LIBRARY_STORAGE_ORIGIN']) {
    let url
    try {
      url = new URL(env[name])
    } catch {
      throw new Error(`Invalid image library origin: ${name}`)
    }
    if (url.protocol !== 'https:' || url.origin !== env[name])
      throw new Error(`Image library origin must be an HTTPS origin without a path: ${name}`)
  }
  if (env.RENDER_LIBRARY_SUPABASE_URL !== env.VITE_RENDER_LIBRARY_STORAGE_ORIGIN)
    throw new Error('Image library server and browser storage origins must match.')
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    checkLibraryEnv(process.env)
  } catch (error) {
    console.error(error.message)
    process.exitCode = 1
  }
}

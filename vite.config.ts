import { defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import manifest from './public/textures/manifest.json'

/** Emit only content-verified, hashed texture URLs. Public originals remain revalidated. */
function textureAssets(): Plugin {
  let production = false
  let base = '/'
  return {
    name: 'fury-versioned-textures',
    configResolved(config) {
      production = config.command === 'build'
      base = config.base
    },
    resolveId(id) {
      if (id === 'virtual:fury-textures') return '\0fury-textures'
    },
    load(id) {
      if (id !== '\0fury-textures') return
      const maps = Object.entries(manifest.maps).map(([key, info]) => {
        const content = readFileSync(
          fileURLToPath(new URL(`./public/textures/${info.file}`, import.meta.url)),
        )
        if (createHash('sha256').update(content).digest('hex') !== info.sha256)
          throw new Error(
            `Stale texture manifest: ${info.file}; run scripts/build-textures.py --manifest-only`,
          )
        const url = production
          ? `import.meta.ROLLUP_FILE_URL_${this.emitFile({ type: 'asset', name: `${key.replace('/', '-')}.webp`, source: content })}`
          : JSON.stringify(`${base}textures/${info.file}?v=${info.sha256}`)
        const runtime = {
          sha256: info.sha256,
          width: info.width,
          height: info.height,
          encodedBytes: info.encodedBytes,
        }
        return `${JSON.stringify(key)}:{...${JSON.stringify(runtime)},url:${url}}`
      })
      return `export default { maps: { ${maps.join(',')} } }`
    },
    generateBundle(_, bundle) {
      const chunks = Object.values(bundle)
        .filter((output) => output.type === 'chunk')
        .map((chunk) => ({
          file: chunk.fileName,
          isEntry: chunk.isEntry,
          imports: chunk.imports,
          dynamicImports: chunk.dynamicImports,
          modules: Object.keys(chunk.modules).map((id) =>
            id
              .replaceAll('\\', '/')
              .replace(/^.*\/node_modules\//, 'node_modules/')
              .replace(/^.*\/src\//, 'src/'),
          ),
        }))
      this.emitFile({
        type: 'asset',
        fileName: 'build-graph.json',
        source: JSON.stringify(chunks, null, 2),
      })
    },
  }
}

export default defineConfig({
  plugins: [react(), textureAssets()],
  server: { host: '0.0.0.0', allowedHosts: true },
  build: {
    target: 'es2022',
    manifest: true,
  },
})

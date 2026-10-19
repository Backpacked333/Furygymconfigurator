import { fileURLToPath } from 'node:url'
import { build } from 'vite'
import { expect, it } from 'vitest'
import { admittedResource } from './resources'

it('bundles only the private scene graph and authored worker, entirely in memory without app plugins or publication', async () => {
  const root = fileURLToPath(new URL('../../../../../', import.meta.url))
  const input = fileURLToPath(new URL('./worker.html', import.meta.url))
  const modules: string[] = []
  const result = await build({
    configFile: false,
    root,
    publicDir: false,
    logLevel: 'silent',
    esbuild: { jsx: 'automatic' },
    plugins: [
      {
        name: 'private-graph-check',
        generateBundle() {
          modules.push(...this.getModuleIds())
        },
      },
    ],
    build: {
      write: false,
      emptyOutDir: false,
      minify: false,
      target: 'es2022',
      rollupOptions: { input },
    },
  })
  const builds = Array.isArray(result) ? result : [result]
  const files = builds.flatMap((item) =>
    'output' in item ? item.output.map((file) => file.fileName) : [],
  )
  const worker = files.filter((path) => /^assets\/siteLight\.worker-[A-Za-z0-9_-]+\.js$/.test(path))
  expect(worker).toHaveLength(1)
  expect(admittedResource(`/${worker[0]}`, 'http://127.0.0.1:9876', 'worker')).toBeInstanceOf(URL)
  for (const name of ['Atmosphere', 'Landscape', 'StudioModel', 'InteriorProbe'])
    expect(modules.some((id) => id.endsWith(`/components/${name}.tsx`))).toBe(true)
  expect(modules.some((id) => id.endsWith('/render/pipeline.ts'))).toBe(true)
  expect(modules.some((id) => id.endsWith('/browser/scene.tsx'))).toBe(true)
  expect(
    modules.filter((id) =>
      /\/src\/(?:components\/(?:Scene|RenderEffects|App)\.|(?:app|store|services)\/|render\/(?:cloud|pathtrace)\.|render\/prototype\/(?:register|prepare|fixtures|materialCapture)\.)/.test(
        id,
      ),
    ),
  ).toEqual([])
  expect(
    modules.filter((id) =>
      /(?:three-gpu-pathtracer|jspdf|prototype-image-plugin|bakedStills|stills\.manifest|virtual:fury-stills)/.test(
        id,
      ),
    ),
  ).toEqual([])
}, 120_000)

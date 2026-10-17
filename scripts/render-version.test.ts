import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  RENDER_SOURCES,
  VERSION_LENGTH,
  isRenderSource,
  renderSources,
  renderVersion,
} from './render-version'

const REPO = fileURLToPath(new URL('..', import.meta.url))
const SOURCES = { directories: ['src/render'], files: ['src/lib/visuals.ts', 'server/blender.py'] }

describe('the render version', () => {
  let root: string
  const write = (file: string, text: string) => {
    mkdirSync(join(root, file, '..'), { recursive: true })
    writeFileSync(join(root, file), text)
  }
  const version = () => renderVersion(root, renderSources(root, SOURCES))
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'render-version-'))
    write('src/render/stills.ts', 'export const QUALITY = 1024\n')
    write('src/render/nested/sky.ts', 'export const SUN = 1\n')
    write('src/render/stills.test.ts', 'it("renders")\n')
    write('src/lib/visuals.ts', 'export const SKY = 2\n')
    write('server/blender.py', 'SAMPLES = 1024\n')
    write('src/App.tsx', 'export default null\n')
  })
  afterEach(() => rmSync(root, { recursive: true, force: true }))

  it('counts the render sources, tests and everything else aside', () => {
    expect(renderSources(root, SOURCES)).toEqual([
      'server/blender.py',
      'src/lib/visuals.ts',
      'src/render/nested/sky.ts',
      'src/render/stills.ts',
    ])
  })

  it('is the same for the same sources, and short', () => {
    const first = version()
    expect(first).toMatch(new RegExp(`^[0-9a-f]{${VERSION_LENGTH}}$`))
    expect(version()).toBe(first)
    // Line endings as a Windows checkout writes them change nothing.
    write('src/lib/visuals.ts', 'export const SKY = 2\r\n')
    expect(version()).toBe(first)
  })

  it('changes when a render source is touched, added or renamed', () => {
    const first = version()
    write('src/render/stills.ts', 'export const QUALITY = 2048\n')
    const touched = version()
    expect(touched).not.toBe(first)
    write('server/blender.py', 'SAMPLES = 512\n')
    expect(version()).not.toBe(touched)
    write('server/blender.py', 'SAMPLES = 1024\n')
    write('src/render/stills.ts', 'export const QUALITY = 1024\n')
    expect(version()).toBe(first)
    write('src/render/added.ts', 'export {}\n')
    expect(version()).not.toBe(first)
    rmSync(join(root, 'src/render/added.ts'))
    rmSync(join(root, 'src/render/nested/sky.ts'))
    write('src/render/nested/sun.ts', 'export const SUN = 1\n')
    expect(version()).not.toBe(first)
  })

  it('leaves tests and the rest of the app out of it', () => {
    const first = version()
    write('src/render/stills.test.ts', 'it("renders twice")\n')
    write('src/App.tsx', 'export default 1\n')
    expect(version()).toBe(first)
  })

  it('hashes images byte for byte, and only the pinning lines of a deploy script', () => {
    const files = [...renderSources(root, SOURCES), 'textures/plywood/albedo.webp', 'deploy.py']
    write('textures/plywood/albedo.webp', 'RIFF\r\n1234WEBP')
    write('deploy.py', 'GPU = "L40S"\nimage.pip_install("bpy==4.5.0")\n')
    const lines = { lines: { 'deploy.py': /bpy==/ } }
    const first = renderVersion(root, files, lines)
    // A scan exported again, even only its line-ending bytes: another renderer.
    write('textures/plywood/albedo.webp', 'RIFF\n1234WEBP')
    const rescanned = renderVersion(root, files, lines)
    expect(rescanned).not.toBe(first)
    // The deploy script's other settings change no pixel; Blender's version does.
    write('deploy.py', 'GPU = "L40S:2"\nimage.pip_install("bpy==4.5.0")\n')
    expect(renderVersion(root, files, lines)).toBe(rescanned)
    write('deploy.py', 'GPU = "L40S:2"\nimage.pip_install("bpy==4.6.0")\n')
    expect(renderVersion(root, files, lines)).not.toBe(rescanned)
  })

  it('tells a render source from the rest, as the dev server watches them', () => {
    expect(isRenderSource('src/render/stills.ts')).toBe(true)
    expect(isRenderSource('public/textures/plywood/albedo.webp')).toBe(true)
    expect(isRenderSource('src/components/Scene.tsx')).toBe(true)
    expect(isRenderSource('render-server/modal_app.py')).toBe(true)
    expect(isRenderSource('src/render/stills.test.ts')).toBe(false)
    expect(isRenderSource('src/render/.notes.md')).toBe(false)
    expect(isRenderSource('src/App.tsx')).toBe(false)
    expect(isRenderSource('src/stills.manifest.json')).toBe(false)
  })

  it('names a listed file that is gone', () => {
    rmSync(join(root, 'server/blender.py'))
    expect(() => renderVersion(root, ['server/blender.py'])).toThrow(/server\/blender\.py/)
  })

  it("lists this repository's render sources, which all exist", () => {
    const files = renderSources(REPO)
    expect(files).toEqual(expect.arrayContaining(RENDER_SOURCES.files))
    expect(files).toEqual(
      expect.arrayContaining([
        'src/render/stills.ts',
        'src/render/gallery.ts',
        'src/components/Scene.tsx',
        'render-server/fury_render/finishing.py',
        'render-server/requirements.txt',
        'public/textures/sources.json',
        'public/textures/plywood/albedo.webp',
      ]),
    )
    expect(files.some((file) => file.includes('.test.'))).toBe(false)
    expect(files).not.toContain('src/App.tsx')
    expect(renderVersion(REPO)).toMatch(/^[0-9a-f]{10}$/)
  })
})

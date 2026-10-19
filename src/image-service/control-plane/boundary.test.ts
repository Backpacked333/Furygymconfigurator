import { readFileSync, existsSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import ts from 'typescript'
import { build } from 'esbuild'
import { describe, expect, it } from 'vitest'
import { EXECUTION_POLICY, PAID_EXECUTION_ALLOWED, PUBLIC_STREAMS_ENABLED } from './contracts'

import { REPO_ROOT as ROOT } from './testPaths'

// Parse import edges only; never evaluate browser/renderer entrypoints or start a Vite server.
function closure(entry: string): string[] {
  const seen = new Set<string>()
  function visit(file: string) {
    if (seen.has(file)) return
    seen.add(file)
    const ast = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true)
    const targets: string[] = []
    function walk(node: ts.Node) {
      if (
        (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
        node.moduleSpecifier &&
        ts.isStringLiteral(node.moduleSpecifier)
      )
        targets.push(node.moduleSpecifier.text)
      if (
        ts.isCallExpression(node) &&
        node.expression.kind === ts.SyntaxKind.ImportKeyword &&
        node.arguments[0] &&
        ts.isStringLiteral(node.arguments[0])
      )
        targets.push(node.arguments[0].text)
      ts.forEachChild(node, walk)
    }
    walk(ast)
    for (const target of targets) {
      if (!target.startsWith('.')) continue
      const base = resolve(dirname(file), target)
      const path = [
        base,
        `${base}.ts`,
        `${base}.tsx`,
        `${base}/index.ts`,
        `${base}/index.tsx`,
      ].find((candidate) => /\.[cm]?[jt]sx?$/.test(candidate) && existsSync(candidate))
      if (path) visit(path)
    }
  }
  visit(resolve(ROOT, entry))
  return [...seen]
}

describe('P04 private execution boundaries (static/in-memory only)', () => {
  it.each(['src/main.tsx', 'src/prototype/ImageConfigurator.tsx', 'src/review/main.tsx'])(
    'keeps %s import closure free of the private control plane',
    (entry) => {
      const files = closure(entry)
      expect(files.length).toBeGreaterThan(1)
      expect(files.filter((file) => file.includes('/image-service/control-plane/'))).toEqual([])
    },
  )

  it('bundles the server control plane without any renderer, capture runner, cloud client or paid SDK', async () => {
    const result = await build({
      absWorkingDir: ROOT,
      entryPoints: [
        'src/image-service/control-plane/worker.ts',
        'src/image-service/control-plane/watchdog.ts',
        'src/image-service/control-plane/api.ts',
      ],
      bundle: true,
      write: false,
      outdir: 'unused',
      metafile: true,
      platform: 'node',
      format: 'esm',
      packages: 'external',
      logLevel: 'silent',
    })
    const inputs = Object.keys(result.metafile!.inputs)
    expect(inputs.some((file) => file.endsWith('/worker.ts'))).toBe(true)
    expect(
      inputs.filter((file) =>
        /src\/render\/|src\/components\/|render-server|capture\/runner|localRenderService/.test(
          file,
        ),
      ),
    ).toEqual([])
    const code = result.outputFiles.map((file) => file.text).join('\n')
    expect(code).not.toMatch(
      /VITE_CLOUD_RENDER_URL|modal\.com|supabase\.co|api\.vercel\.com|WebGPURenderer|runCapture\(/,
    )
  })

  it('cannot enable paid execution or public streams through immutable policy', () => {
    expect(EXECUTION_POLICY).toEqual({
      provider: 'fake-local',
      paidExecutionAllowed: false,
      productionAllowed: false,
      publicStreamsEnabled: false,
    })
    expect(Object.isFrozen(EXECUTION_POLICY)).toBe(true)
    expect(PAID_EXECUTION_ALLOWED).toBe(false)
    expect(PUBLIC_STREAMS_ENABLED).toBe(false)
    const api = readFileSync(resolve(ROOT, 'src/image-service/control-plane/api.ts'), 'utf8')
    expect(api).not.toMatch(/from ['"].*\/(worker|provider|watchdog)['"]/)
  })
})

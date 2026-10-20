import { existsSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')

describe('neutral shared presentation boundary', () => {
  it('has no runtime path to renderer, PDF, domain, Config, legacy storage or side-effect adapters', () => {
    const seen = new Set<string>()
    function inspect(file: string) {
      if (seen.has(file)) return
      seen.add(file)
      const text = readFileSync(file, 'utf8')
      expect(text).not.toMatch(
        /localStorage|sessionStorage|navigator\.clipboard|fetch\s*\(|window\.history/,
      )
      const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true)
      function visit(node: ts.Node) {
        let path: string | undefined
        if (
          ts.isImportDeclaration(node) &&
          !node.importClause?.isTypeOnly &&
          ts.isStringLiteral(node.moduleSpecifier)
        )
          path = node.moduleSpecifier.text
        if (
          ts.isExportDeclaration(node) &&
          !node.isTypeOnly &&
          node.moduleSpecifier &&
          ts.isStringLiteral(node.moduleSpecifier)
        )
          path = node.moduleSpecifier.text
        if (
          ts.isCallExpression(node) &&
          node.expression.kind === ts.SyntaxKind.ImportKeyword &&
          ts.isStringLiteral(node.arguments[0])
        )
          path = node.arguments[0].text
        if (path) {
          expect(path).not.toMatch(
            /three|render|worker|cloud|pdf|prefetch|review|domain|lib\/(config|export|recovery)|Dialogs|App|legacyEntry/i,
          )
          if (path.startsWith('.')) {
            const base = resolve(dirname(file), path)
            const dependency = [base, base + '.tsx', base + '.ts'].find(existsSync)
            expect(dependency, path).toBeDefined()
            inspect(dependency!)
          }
        }
        ts.forEachChild(node, visit)
      }
      visit(source)
    }
    inspect(resolve(root, 'components/BuildDialogView.tsx'))
    inspect(resolve(root, 'components/SpecificationView.tsx'))
    expect(seen.has(resolve(root, 'components/Modal.tsx'))).toBe(true)
  })

  it('uses the actual shared bodies from both legacy and v4 adapters', () => {
    const legacy = readFileSync(resolve(root, 'components/Dialogs.tsx'), 'utf8')
    const library = readFileSync(resolve(root, 'prototype/DesignLibrary.tsx'), 'utf8')
    const specification = readFileSync(resolve(root, 'prototype/DesignSpecification.tsx'), 'utf8')
    for (const component of ['BuildLibraryView', 'BuildShareView', 'SavedBuildView']) {
      expect(legacy).toContain(`<${component}`)
      expect(library).toContain(`<${component}`)
    }
    expect(legacy).toContain('<SpecificationView')
    expect(specification).toContain('<SpecificationView')
    expect(specification).toContain('<FloorPlan')
    expect(specification).not.toContain('<svg')
    expect(readFileSync(resolve(root, 'App.tsx'), 'utf8')).toContain('<FloorPlan')
  })
})

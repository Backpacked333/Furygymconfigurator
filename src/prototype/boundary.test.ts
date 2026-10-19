import { existsSync, readFileSync } from 'node:fs'
import { dirname, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
function imports(file: string) {
  const source = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true)
  const imports: string[] = []
  function visit(node: ts.Node) {
    if (
      ts.isImportDeclaration(node) &&
      !node.importClause?.isTypeOnly &&
      ts.isStringLiteral(node.moduleSpecifier)
    )
      imports.push(node.moduleSpecifier.text)
    if (
      ts.isExportDeclaration(node) &&
      !node.isTypeOnly &&
      node.moduleSpecifier &&
      ts.isStringLiteral(node.moduleSpecifier)
    )
      imports.push(node.moduleSpecifier.text)
    if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword &&
      ts.isStringLiteral(node.arguments[0])
    )
      imports.push(node.arguments[0].text)
    ts.forEachChild(node, visit)
  }
  visit(source)
  return imports
}

// Verify actual JSX consumers, not matching class names or imports left unused for a test.
// DOM interaction suites separately exercise these presenters/adapters; neither proves pixels.
const reuseMatrix = [
  ['ConfiguratorShell', 'ConfiguratorShell', 'App.tsx', 'prototype/ImageConfigurator.tsx'],
  ['ConfiguratorShell', 'ConfiguratorPanelToggle', 'App.tsx', 'prototype/ImageConfigurator.tsx'],
  ['ConfiguratorShell', 'ConfiguratorSummary', 'App.tsx', 'prototype/ImageConfigurator.tsx'],
  ['ConfiguratorShell', 'ConfiguratorNotification', 'App.tsx', 'prototype/ImageConfigurator.tsx'],
  ['ConfigPanelView', 'ConfigPanelView', 'components/ConfigPanel.tsx', 'prototype/DesignPanel.tsx'],
  ['StageHeader', 'StageHeader', 'App.tsx', 'prototype/ImageConfigurator.tsx'],
  ['StagePresentation', 'StageFrame', 'App.tsx', 'prototype/ImageConfigurator.tsx'],
  [
    'StagePresentation',
    'StageImageLayers',
    'components/StillStage.tsx',
    'prototype/ImageConfigurator.tsx',
  ],
  [
    'StagePresentation',
    'StageFilmstrip',
    'components/StillStage.tsx',
    'prototype/ImageConfigurator.tsx',
  ],
  [
    'StageToolbarView',
    'StageToolbarView',
    'components/StageToolbar.tsx',
    'prototype/ImageConfigurator.tsx',
  ],
  ['BuildDialogView', 'BuildLibraryView', 'components/Dialogs.tsx', 'prototype/DesignLibrary.tsx'],
  ['BuildDialogView', 'BuildShareView', 'components/Dialogs.tsx', 'prototype/DesignLibrary.tsx'],
  ['BuildDialogView', 'SavedBuildView', 'components/Dialogs.tsx', 'prototype/DesignLibrary.tsx'],
  [
    'BuildDialogView',
    'EmptyBuildLibraryView',
    'components/Dialogs.tsx',
    'prototype/DesignLibrary.tsx',
  ],
  [
    'SpecificationView',
    'SpecificationView',
    'components/Dialogs.tsx',
    'prototype/DesignSpecification.tsx',
  ],
  ['FloorPlan', 'default', 'App.tsx', 'prototype/DesignSpecification.tsx'],
] as const

describe('shared-source reuse matrix', () => {
  it.each(reuseMatrix)(
    '%s exports %s consumed by both %s and %s',
    (module, exported, ...consumers) => {
      for (const consumer of consumers) {
        const file = resolve(root, consumer)
        const source = ts.createSourceFile(
          file,
          readFileSync(file, 'utf8'),
          ts.ScriptTarget.Latest,
          true,
        )
        const declaration = source.statements
          .filter(ts.isImportDeclaration)
          .find(
            (node) =>
              ts.isStringLiteral(node.moduleSpecifier) &&
              resolve(dirname(file), node.moduleSpecifier.text) ===
                resolve(root, `components/${module}`),
          )
        expect(declaration, consumer).toBeDefined()
        const clause = declaration?.importClause
        expect(clause?.isTypeOnly).toBe(false)
        const bindings = clause?.namedBindings
        const local =
          exported === 'default'
            ? clause?.name?.text
            : bindings && ts.isNamedImports(bindings)
              ? bindings.elements.find(
                  (node) => !node.isTypeOnly && (node.propertyName ?? node.name).text === exported,
                )?.name.text
              : undefined
        expect(local, consumer).toBeDefined()
        let used = false
        function visit(node: ts.Node) {
          if (
            (ts.isJsxSelfClosingElement(node) || ts.isJsxOpeningElement(node)) &&
            node.tagName.getText(source) === local
          )
            used = true
          ts.forEachChild(node, visit)
        }
        visit(source)
        expect(used, `${consumer} must mount ${local}, not merely import it`).toBe(true)
      }
    },
  )
  it('keeps shared presentation free of automatic network, storage and renderer startup', () => {
    for (const module of new Set([
      ...reuseMatrix.map(([module]) => module),
      'StagePresentationHooks',
    ])) {
      const source = readFileSync(resolve(root, `components/${module}.tsx`), 'utf8')
      expect(source, module).not.toMatch(
        /\b(fetch|XMLHttpRequest|WebSocket|Worker|localStorage|sessionStorage)\b/,
      )
      expect(imports(resolve(root, `components/${module}.tsx`)), module).not.toEqual(
        expect.arrayContaining([expect.stringMatching(/render|prefetch|cloud|export|useConfig/)]),
      )
    }
  })
})

describe('prototype runtime source dependency boundary', () => {
  it('has no path to Three, renderers, workers, provider SDKs, review entry, textures or PDF', () => {
    // These exact browser-safe cloud wire modules are additive, not provider implementations.
    // Continue recursively inspecting their complete graph; never exempt a directory or suffix.
    const publicCloudModules = new Set([
      resolve(root, 'display/cloudContract'),
      resolve(root, 'prototype/cloudDisplayClient'),
      resolve(root, 'prototype/useCloudDisplayImage'),
    ])
    const seen = new Set<string>()
    function inspect(file: string) {
      if (seen.has(file)) return
      seen.add(file)
      expect(relative(root, file)).not.toMatch(
        /^(render\/|review\/|image-service\/(display|remote-display)\/|display\/(session|cloudSession|readiness|operator)\.|App\.tsx|legacyEntry\.tsx|lib\/(export|useConfig)\.ts|components\/(ConfigPanel|StageToolbar|Dialogs)\.tsx)/,
      )
      for (const path of imports(file)) {
        expect(path).not.toMatch(
          /three|jspdf|worker|texture|pathtrace|node:|remote-display|cloudSession/i,
        )
        expect(path).not.toMatch(/^(?:@modal\/|modal(?:[-/]|$))/i)
        if (!path.startsWith('.') || !publicCloudModules.has(resolve(dirname(file), path)))
          expect(path).not.toMatch(/cloud/i)
        if (!path.startsWith('.') || path.endsWith('.css')) continue
        const base = resolve(dirname(file), path)
        const next = [base, base + '.ts', base + '.tsx', base + '.json'].find((candidate) =>
          existsSync(candidate),
        )
        expect(next, `Missing dependency ${path}`).toBeDefined()
        if (next && !next.endsWith('.json')) inspect(next)
      }
    }
    inspect(resolve(root, 'prototype/ImageConfigurator.tsx'))
    expect(seen.has(resolve(root, 'image-service/protocol.ts'))).toBe(true)
    expect(seen.has(resolve(root, 'components/Elevation.tsx'))).toBe(true)
    for (const component of [
      'ConfiguratorShell',
      'ConfigPanelView',
      'StageHeader',
      'StagePresentation',
      'StagePresentationHooks',
      'StageToolbarView',
      'BuildDialogView',
      'SpecificationView',
      'FloorPlan',
    ])
      expect(seen.has(resolve(root, `components/${component}.tsx`)), component).toBe(true)
    expect(seen.size).toBeGreaterThan(10)
  })
  it('keeps entry selection DEV-only and isolates original v3 bootstrap', () => {
    const main = readFileSync(resolve(root, 'main.tsx'), 'utf8')
    const source = ts.createSourceFile('main.tsx', main, ts.ScriptTarget.Latest, true)
    const statics = source.statements
      .filter(ts.isImportDeclaration)
      .map((node) => (node.moduleSpecifier as ts.StringLiteral).text)
    expect(statics).not.toContain('./App')
    expect(statics).not.toContain('./legacyEntry')
    expect(statics.some((name) => /render|bake|stillKey/.test(name))).toBe(false)
    expect(main.replace(/\s+/g, ' ')).toContain(
      "import.meta.env.DEV && new URLSearchParams(window.location.search).get('prototype') === 'images'",
    )
    expect(main).toContain("import('./legacyEntry')")
    const legacy = readFileSync(resolve(root, 'legacyEntry.tsx'), 'utf8')
    expect(legacy).toContain("import App from './App'")
    expect(legacy).toContain('bakeRefusal(window.location.search, navigator.webdriver === true)')
    expect(legacy).toContain('window.__bakeDesigns = bakeDesigns()')
  })
})

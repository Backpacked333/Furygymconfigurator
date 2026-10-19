import js from '@eslint/js'
import globals from 'globals'
import tseslint from 'typescript-eslint'
import reactHooks from 'eslint-plugin-react-hooks'
import reactRefresh from 'eslint-plugin-react-refresh'

export default tseslint.config(
  { ignores: ['dist', 'dist-published', 'render/out'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['**/*.{ts,tsx}'],
    languageOptions: { globals: globals.browser },
    plugins: { 'react-hooks': reactHooks, 'react-refresh': reactRefresh },
    rules: {
      ...reactHooks.configs.recommended.rules,
      'react-refresh/only-export-components': ['warn', { allowConstantExport: true }],
    },
  },
  // viewer360 is a framework other products import: it may depend on three, React, and R3F, never
  // on the product around it (see src/viewer/README.md).
  {
    files: ['src/viewer/**/*.{ts,tsx}'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['../*', '@fury/*'],
              message: 'viewer360 must stay product-agnostic: import only from within src/viewer.',
            },
          ],
        },
      ],
    },
  },
  // Build and render tooling runs in Node.
  {
    files: ['scripts/**/*.{js,mjs}', 'render/**/*.ts'],
    languageOptions: { globals: globals.node },
  },
)

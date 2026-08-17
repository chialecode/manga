import eslint from '@eslint/js'
import tseslint from 'typescript-eslint'

export const noBareNewBrowserWindow = {
  meta: { type: 'problem', schema: [], messages: { forbidden: 'BrowserWindow may only be constructed in the window factory.' } },
  create(context) {
    return {
      NewExpression(node) {
        const isBrowserWindow = (node.callee.type === 'Identifier' && node.callee.name === 'BrowserWindow') ||
          (node.callee.type === 'MemberExpression' && !node.callee.computed && node.callee.property.type === 'Identifier' && node.callee.property.name === 'BrowserWindow')
        if (!isBrowserWindow) return
        const filename = context.filename.replaceAll('\\', '/')
        if (!filename.endsWith('apps/desktop/src/main/window/create-window.ts')) {
          context.report({ node, messageId: 'forbidden' })
        }
      },
    }
  },
}

export default tseslint.config(
  { ignores: ['node_modules/**', '**/.vite/**', '**/out/**', '**/dist/**', 'vendor-bin/**', 'apps/svc-db/vite.config.ts'] },
  eslint.configs.recommended,
  ...tseslint.configs.strictTypeChecked,
  ...tseslint.configs.stylisticTypeChecked,
  {
    files: ['**/*.ts', '**/*.tsx'],
    plugins: { local: { rules: { 'no-bare-new-browserwindow': noBareNewBrowserWindow } } },
    languageOptions: {
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
    },
    rules: {
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/consistent-type-imports': 'error',
      'no-console': 'error',
      'local/no-bare-new-browserwindow': 'error',
    },
  },
  {
    files: ['**/*.mjs', '**/*.cjs', 'eslint.config.js'],
    extends: [tseslint.configs.disableTypeChecked],
    languageOptions: {
      globals: {
        process: 'readonly',
        Buffer: 'readonly',
        URL: 'readonly',
        setTimeout: 'readonly',
        clearTimeout: 'readonly',
        setInterval: 'readonly',
        clearInterval: 'readonly',
        fetch: 'readonly',
        structuredClone: 'readonly',
      },
    },
  },
  {
    files: ['**/*.cjs'],
    languageOptions: { globals: { require: 'readonly' } },
    rules: { '@typescript-eslint/no-require-imports': 'off' },
  },
)

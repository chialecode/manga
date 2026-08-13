import assert from 'node:assert/strict'
import test from 'node:test'
import { Linter } from 'eslint'
import { noBareNewBrowserWindow } from '../../eslint.config.js'

const linter = new Linter()
const config = {
  files: ['**/*.ts'],
  languageOptions: { ecmaVersion: 'latest', sourceType: 'module' },
  plugins: { local: { rules: { 'no-bare-new-browserwindow': noBareNewBrowserWindow } } },
  rules: { 'local/no-bare-new-browserwindow': 'error' },
}

test('window factory may construct BrowserWindow', () => {
  const messages = linter.verify('new BrowserWindow({})', config, {
    filename: 'apps/desktop/src/main/window/create-window.ts',
  })
  assert.deepEqual(messages, [])
})

test('counterexample: BrowserWindow construction outside factory is an ESLint error', () => {
  const messages = linter.verify('new BrowserWindow({})', config, {
    filename: 'packages/features/src/bad-window.ts',
  })
  assert.equal(messages.some((message) => message.ruleId === 'local/no-bare-new-browserwindow' && message.severity === 2), true)
})

test('counterexample: electron.BrowserWindow construction outside factory is an ESLint error', () => {
  const messages = linter.verify('new electron.BrowserWindow({})', config, {
    filename: 'packages/features/src/bad-window.ts',
  })
  assert.equal(messages.some((message) => message.ruleId === 'local/no-bare-new-browserwindow' && message.severity === 2), true)
})

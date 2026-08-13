import assert from 'node:assert/strict'
import test from 'node:test'
import { redact } from '../../apps/desktop/src/main/logger/redact.ts'
import { redactionViolations } from '../lib/runtime-guards.mjs'
test('counterexample: sensitive fixture is changed before output', () => {
  const raw = { apiKey: 'secret-value', path: 'C:\\Users\\x\\file.epub', title: 'private-title', token: 'media-token' }
  assert.deepEqual(redactionViolations(redact(raw), Object.values(raw)), [])
})

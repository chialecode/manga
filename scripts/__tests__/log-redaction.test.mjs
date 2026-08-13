import assert from 'node:assert/strict'
import test from 'node:test'
import { serializeLog } from '../../apps/desktop/src/main/logger/redact.ts'
import { redactionViolations } from '../lib/runtime-guards.mjs'

test('real logger serialization redacts every sensitive fixture', () => {
  const secrets = ['secret-value', 'C:\\Users\\x\\file.epub', '\\\\server\\share\\private.cbz', '/home/x/private.pdf', 'private-title', 'media-token']
  const output = serializeLog({
    apiKey: secrets[0],
    message: `failed ${secrets[1]} at ${secrets[2]} and ${secrets[3]}`,
    title: secrets[4],
    token: secrets[5],
  })
  assert.deepEqual(redactionViolations(output, secrets), [])
})

test('counterexample: the same guard rejects a broken logger redactor', () => {
  const secret = 'secret-value'
  const output = serializeLog({ apiKey: secret }, (value) => value)
  assert.match(redactionViolations(output, [secret])[0] ?? '', /logger emitted/)
})

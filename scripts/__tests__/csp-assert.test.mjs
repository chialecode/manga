import assert from 'node:assert/strict'
import test from 'node:test'
import { cspViolations, repositoryCspViolations } from '../lib/security-assertions.mjs'

test('repository CSP contains the locked directives', async () => {
  assert.deepEqual(await repositoryCspViolations(process.cwd()), [])
})

test('counterexample: executable book scripts are rejected', () => {
  const weakened = {
    APP_CSP: ["default-src 'none'"],
    BOOK_CSP: ["default-src 'none'", "script-src 'self'"],
  }
  assert.match(cspViolations(weakened).join('\n'), /BOOK_CSP/)
})

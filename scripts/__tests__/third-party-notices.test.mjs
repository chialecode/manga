import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { thirdPartyNoticeViolations } from '../lib/runtime-guards.mjs'

test('third-party notices match lockfile', async () => {
  assert.deepEqual(thirdPartyNoticeViolations(await readFile('pnpm-lock.yaml', 'utf8'), await readFile('THIRD-PARTY-NOTICES.md', 'utf8')), [])
})
test('counterexample: stale notice is rejected', () => assert.match(thirdPartyNoticeViolations('new lock', 'old notice')[0] ?? '', /stale/))

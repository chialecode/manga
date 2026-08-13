import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { thirdPartyNoticeViolations } from '../lib/runtime-guards.mjs'

test('third-party notices match lockfile', async () => {
  const generated = spawnSync(process.execPath, ['scripts/generate-third-party-notices.mjs'], { encoding: 'utf8' })
  assert.equal(generated.status, 0, generated.stderr)
  assert.deepEqual(thirdPartyNoticeViolations(await readFile('pnpm-lock.yaml', 'utf8'), await readFile('THIRD-PARTY-NOTICES.md', 'utf8'), await readFile('sbom.spdx.json', 'utf8')), [])
})
test('counterexample: stale placeholder notices and empty SBOM are rejected', () => {
  const violations = thirdPartyNoticeViolations('new lock', 'old notice', '{"packages":[],"relationships":[]}')
  assert.equal(violations.some((value) => value.includes('stale')), true)
  assert.equal(violations.some((value) => value.includes('inventory')), true)
  assert.equal(violations.some((value) => value.includes('relationships')), true)
})

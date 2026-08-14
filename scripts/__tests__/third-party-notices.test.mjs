import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { thirdPartyNoticeViolations } from '../lib/runtime-guards.mjs'

// The generator must run against a scratch directory. Regenerating in place
// would silently repair stale committed artifacts instead of failing, and it
// would leave the working tree dirty after every guard run.
async function generateInto(directory) {
  const run = spawnSync(process.execPath, ['scripts/generate-third-party-notices.mjs', directory], { encoding: 'utf8' })
  assert.equal(run.status, 0, run.stderr)
  return {
    notice: await readFile(join(directory, 'THIRD-PARTY-NOTICES.md'), 'utf8'),
    sbom: JSON.parse(await readFile(join(directory, 'sbom.spdx.json'), 'utf8')),
  }
}

test('committed notices and SBOM match the current lockfile', async (t) => {
  const scratch = await mkdtemp(join(tmpdir(), 'notices-'))
  t.after(() => rm(scratch, { recursive: true, force: true }))
  const fresh = await generateInto(scratch)
  const committedNotice = await readFile('THIRD-PARTY-NOTICES.md', 'utf8')
  const committedSbom = JSON.parse(await readFile('sbom.spdx.json', 'utf8'))

  assert.deepEqual(thirdPartyNoticeViolations(await readFile('pnpm-lock.yaml', 'utf8'), committedNotice, JSON.stringify(committedSbom)), [])
  assert.equal(committedNotice, fresh.notice, 'THIRD-PARTY-NOTICES.md is stale; run pnpm licenses:generate')
  assert.equal(committedSbom.lockfileSha256, fresh.sbom.lockfileSha256, 'sbom.spdx.json is stale; run pnpm licenses:generate')
  assert.deepEqual(committedSbom.packages, fresh.sbom.packages, 'sbom.spdx.json package inventory is stale')
  assert.deepEqual(committedSbom.relationships, fresh.sbom.relationships, 'sbom.spdx.json relationships are stale')
})

test('regenerating an unchanged inventory is byte-identical', async (t) => {
  const scratch = await mkdtemp(join(tmpdir(), 'notices-idempotent-'))
  t.after(() => rm(scratch, { recursive: true, force: true }))
  await generateInto(scratch)
  const first = await readFile(join(scratch, 'sbom.spdx.json'), 'utf8')
  await generateInto(scratch)
  assert.equal(await readFile(join(scratch, 'sbom.spdx.json'), 'utf8'), first)
})

test('counterexample: stale placeholder notices and empty SBOM are rejected', () => {
  const violations = thirdPartyNoticeViolations('new lock', 'old notice', '{"packages":[],"relationships":[]}')
  assert.equal(violations.some((value) => value.includes('stale')), true)
  assert.equal(violations.some((value) => value.includes('inventory')), true)
  assert.equal(violations.some((value) => value.includes('relationships')), true)
})

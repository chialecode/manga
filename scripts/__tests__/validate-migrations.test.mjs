import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { migrationValidationViolations } from '../validate-migrations.mjs'

test('published migrations have continuous numbers and rollback explanations', async () => {
  assert.deepEqual(await migrationValidationViolations('packages/data/migrations'), [])
})

test('counterexample: gap, duplicate, and missing rollback explanation are rejected', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'migration-validation-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  await mkdir(root, { recursive: true })
  await writeFile(join(root, '0002_a.sql'), '-- no explanation\n')
  await writeFile(join(root, '0002_b.sql'), '-- Rollback: drop b\n')
  const violations = await migrationValidationViolations(root)
  assert.equal(violations.some((value) => value.includes('continuous')), true)
  assert.equal(violations.some((value) => value.includes('duplicate')), true)
  assert.equal(violations.some((value) => value.includes('rollback')), true)
})

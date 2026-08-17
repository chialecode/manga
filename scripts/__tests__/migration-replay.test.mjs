import assert from 'node:assert/strict'
import test from 'node:test'
import Database from 'better-sqlite3'
import { readFile, readdir } from 'node:fs/promises'
import { migrationReplayViolations } from '../lib/runtime-guards.mjs'

test('published migrations replay the required Phase 1 schema', async () => {
  const db = new Database(':memory:')
  for (const file of (await readdir('packages/data/migrations')).filter((name) => name.endsWith('.sql')).sort()) db.exec(await readFile(`packages/data/migrations/${file}`, 'utf8'))
  assert.deepEqual(migrationReplayViolations(db), [])
  db.close()
})

test('counterexample: an empty replay lacks the Phase 1 schema', async () => {
  const db = new Database(':memory:')
  const expectedSql = await readFile('packages/data/migrations/0001_init.sql', 'utf8')
  assert.ok(expectedSql.includes('CREATE TABLE file'))
  assert.match(migrationReplayViolations(db)[0] ?? '', /lacks/)
  db.close()
})

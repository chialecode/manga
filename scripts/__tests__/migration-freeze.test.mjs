import assert from 'node:assert/strict'
import { cp, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { migrationFreezeViolations } from '../lib/migrations.mjs'

const migrations = join(process.cwd(), 'packages', 'data', 'migrations')
const lock = join(process.cwd(), 'packages', 'data', 'migrations.lock.json')

test('published migrations match frozen hashes', async () => {
  assert.deepEqual(await migrationFreezeViolations(migrations, lock), [])
})

test('counterexample: changed published migration is rejected', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'migration-freeze-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const copy = join(root, 'migrations')
  await cp(migrations, copy, { recursive: true })
  await writeFile(join(copy, '0001_init.sql'), '-- tampered\n')
  assert.match((await migrationFreezeViolations(copy, lock))[0] ?? '', /hash changed/)
})

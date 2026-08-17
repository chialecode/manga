import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { openDatabase } from '../src/connection.js'
import { migrate } from '../src/migrator.js'

let directory = ''

beforeEach(async () => { directory = await mkdtemp(join(tmpdir(), 'migration-backup-')) })
afterEach(async () => { await rm(directory, { recursive: true, force: true }) })

it('uses online backup before upgrades and retains the latest three snapshots', async () => {
  const migrations = join(directory, 'migrations')
  const backups = join(directory, 'backups')
  await mkdir(migrations)
  await writeFile(join(migrations, '0001_init.sql'), '-- Rollback: drop sample\nCREATE TABLE sample(value TEXT);')
  const databasePath = join(directory, 'db.sqlite')
  const db = openDatabase(databasePath)
  try {
    await migrate(db, migrations, backups)
    db.prepare('INSERT INTO sample(value) VALUES(?)').run('preserved')
    for (let version = 2; version <= 5; version += 1) {
      await writeFile(join(migrations, `000${String(version)}_next.sql`), `-- Rollback: drop v${String(version)}\nCREATE TABLE v${String(version)}(id INTEGER);`)
      await migrate(db, migrations, backups)
      await new Promise((resolve) => setTimeout(resolve, 2))
    }
    const files = (await readdir(backups)).sort()
    expect(files).toHaveLength(3)
    const snapshot = openDatabase(join(backups, files[0] ?? ''))
    try {
      expect(snapshot.prepare('SELECT value FROM sample').get()).toEqual({ value: 'preserved' })
      expect(snapshot.pragma('integrity_check', { simple: true })).toBe('ok')
    } finally { snapshot.close() }
  } finally { db.close() }
})

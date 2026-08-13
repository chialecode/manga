import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { openDatabase } from '../src/connection.js'
import { migrate } from '../src/migrator.js'
import { recoverExpiredTasks } from '../src/recovery.js'

let directory = ''

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'migration-replay-'))
})

afterEach(async () => {
  await rm(directory, { recursive: true, force: true })
})

it('replays from 0001 and uses required indexes', async () => {
  const db = openDatabase(join(directory, 'db.sqlite'))
  try {
    await migrate(db, join(process.cwd(), 'packages', 'data', 'migrations'))
    expect(db.pragma('integrity_check', { simple: true })).toBe('ok')
    expect(db.pragma('user_version', { simple: true })).toBe(1)
    const quickPlan = db.prepare('EXPLAIN QUERY PLAN SELECT * FROM file WHERE quick_fp = ?').all('fp')
    const pathPlan = db.prepare('EXPLAIN QUERY PLAN SELECT * FROM file WHERE root_id = ? AND rel_path = ?').all(1, 'x')
    expect(JSON.stringify(quickPlan)).toContain('file_quick_fp_idx')
    expect(JSON.stringify(pathPlan)).toMatch(/USING (?:COVERING )?INDEX/u)
  } finally {
    db.close()
  }
})

it('recovers expired running tasks without touching active leases', async () => {
  const db = openDatabase(join(directory, 'db.sqlite'))
  try {
    await migrate(db, join(process.cwd(), 'packages', 'data', 'migrations'))
    const insert = db.prepare("INSERT INTO task(kind,state,attempts,lease_until,created_at,updated_at) VALUES('scan','running',0,?,?,?)")
    insert.run(10, 0, 0)
    insert.run(10_000, 0, 0)
    expect(recoverExpiredTasks(db, 100)).toBe(1)
    expect(db.prepare("SELECT count(*) count FROM task WHERE state='running'").get()).toEqual({ count: 1 })
  } finally {
    db.close()
  }
})

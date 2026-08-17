import type Database from 'better-sqlite3'

export function recoverExpiredTasks(db: Database.Database, nowMs: number): number {
  const result = db.prepare(`
    UPDATE task SET state = 'pending', attempts = attempts + 1, updated_at = ?
    WHERE state = 'running' AND lease_until < ?
  `).run(nowMs, nowMs)
  return result.changes
}

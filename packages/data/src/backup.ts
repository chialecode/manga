import type Database from 'better-sqlite3'
import { readdir, rm } from 'node:fs/promises'
import { join } from 'node:path'

export async function backupDatabase(db: Database.Database, destination: string): Promise<void> {
  await db.backup(destination)
}

export async function retainRecentBackups(directory: string, keep = 3): Promise<void> {
  const backups = (await readdir(directory, { withFileTypes: true }))
    .filter((entry) => entry.isFile() && /^backup-pre-\d+-\d+\.sqlite$/u.test(entry.name))
    .map((entry) => entry.name)
    .sort()
  for (const obsolete of backups.slice(0, Math.max(0, backups.length - keep))) {
    await rm(join(directory, obsolete))
  }
}

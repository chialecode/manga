import type Database from 'better-sqlite3'

export async function backupDatabase(db: Database.Database, destination: string): Promise<void> {
  await db.backup(destination)
}

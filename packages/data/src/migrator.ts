import { readFile, readdir } from 'node:fs/promises'
import { basename, join } from 'node:path'
import type Database from 'better-sqlite3'

const MIGRATION_NAME = /^(\d{4})_[a-z0-9-]+\.sql$/u

export async function migrate(db: Database.Database, migrationsDirectory: string): Promise<void> {
  const current = db.pragma('user_version', { simple: true }) as number
  const files = (await readdir(migrationsDirectory)).filter((name) => MIGRATION_NAME.test(name)).sort()
  for (const file of files) {
    const version = Number.parseInt(MIGRATION_NAME.exec(basename(file))?.[1] ?? '', 10)
    if (version <= current) continue
    const sql = await readFile(join(migrationsDirectory, file), 'utf8')
    db.transaction(() => {
      db.exec(sql)
      db.pragma(`user_version = ${String(version)}`)
    })()
  }
}

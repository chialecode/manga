import type Database from 'better-sqlite3'

export type LibraryRootRow = Readonly<{ id: number; path: string; isEnabled: boolean; createdAt: number }>

export function createLibraryRootRepository(db: Database.Database) {
  const insert = db.prepare('INSERT INTO library_root(path, is_enabled, created_at) VALUES(?, ?, ?)')
  const enabled = db.prepare('SELECT id, path, is_enabled, created_at FROM library_root WHERE is_enabled = 1 ORDER BY id')
  return Object.freeze({
    insert(path: string, createdAt: number): number {
      return Number(insert.run(path, 1, createdAt).lastInsertRowid)
    },
    listEnabled(): LibraryRootRow[] {
      return enabled.all().map((row) => {
        const value = row as { id: number; path: string; is_enabled: number; created_at: number }
        return { id: value.id, path: value.path, isEnabled: value.is_enabled === 1, createdAt: value.created_at }
      })
    },
  })
}

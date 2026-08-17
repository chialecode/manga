import Database from 'better-sqlite3'

export function openDatabase(path: string): Database.Database {
  const db = new Database(path)
  db.pragma('journal_mode = WAL')
  db.pragma('synchronous = NORMAL')
  db.pragma('foreign_keys = ON')
  db.pragma('busy_timeout = 5000')
  db.pragma('cache_size = -32000')
  db.pragma('mmap_size = 268435456')
  db.pragma('temp_store = MEMORY')
  db.pragma('wal_autocheckpoint = 1000')
  return db
}

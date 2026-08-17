import Database from 'better-sqlite3'

const [databasePath, workerId] = process.argv.slice(2)
if (!databasePath || !workerId) throw new Error('database path and worker id are required')

const db = new Database(databasePath)
db.pragma('journal_mode = WAL')
db.pragma('synchronous = NORMAL')
db.pragma('busy_timeout = 5000')

let sequence = 0
const insert = db.prepare(
  "INSERT INTO task(kind,state,attempts,lease_until,created_at,updated_at) VALUES(?, 'running', 0, 0, ?, ?)",
)

for (;;) {
  const nowMs = Date.now()
  const id = db.transaction(() => insert.run(`crash-${workerId}-${String(sequence)}`, nowMs, nowMs).lastInsertRowid)()
  process.stdout.write(`COMMITTED ${String(id)}\n`)
  sequence += 1
}

const { DatabaseSync } = require('node:sqlite')
const { app } = require('electron')

app.whenReady().then(() => {
  const database = new DatabaseSync(':memory:')
  try {
    database.exec('CREATE VIRTUAL TABLE probe USING fts5(content)')
    const sqliteVersion = database.prepare('SELECT sqlite_version() AS version').get().version
    process.stdout.write(`${JSON.stringify({ electron: process.versions.electron, node: process.versions.node, sqlite: sqliteVersion, fts5: true })}\n`)
    app.exit(0)
  } finally {
    database.close()
  }
}).catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`)
  app.exit(1)
})

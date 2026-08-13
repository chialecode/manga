import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import Database from 'better-sqlite3'

const ITERATIONS = 1000
const directory = await mkdtemp(join(tmpdir(), 'db-crash-'))
const databasePath = join(directory, 'db.sqlite')
const migration = await readFile(new URL('../migrations/0001_init.sql', import.meta.url), 'utf8')
const db = new Database(databasePath)
db.pragma('journal_mode = WAL')
db.exec(migration)
db.close()

const committed = new Set()
try {
  for (let iteration = 0; iteration < ITERATIONS; iteration += 1) {
    await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [new URL('./crash-worker.mjs', import.meta.url).pathname.slice(1), databasePath, String(iteration)], {
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      })
      let output = ''
      let stderr = ''
      let timer
      child.stdout.setEncoding('utf8')
      child.stdout.on('data', (chunk) => {
        output += chunk
        if (!timer && output.includes('COMMITTED ')) {
          timer = setTimeout(() => child.kill(), Math.floor(Math.random() * 10))
        }
      })
      child.stderr.setEncoding('utf8')
      child.stderr.on('data', (chunk) => {
        stderr += chunk
      })
      child.on('error', reject)
      child.on('exit', () => {
        if (timer) clearTimeout(timer)
        for (const match of output.matchAll(/^COMMITTED (\d+)$/gmu)) committed.add(Number(match[1]))
        if (stderr) reject(new Error(stderr))
        else resolve()
      })
    })
  }

  const verify = new Database(databasePath)
  verify.pragma('busy_timeout = 5000')
  assert.equal(verify.pragma('integrity_check', { simple: true }), 'ok')
  const exists = verify.prepare('SELECT 1 FROM task WHERE id = ?')
  assert.ok(committed.size > 0, 'crash run must observe committed transactions')
  for (const id of committed) assert.ok(exists.get(id), `committed transaction ${String(id)} was lost`)
  verify.prepare("UPDATE task SET state='pending', attempts=attempts+1 WHERE state='running' AND lease_until < ?").run(Date.now())
  assert.equal(verify.prepare("SELECT count(*) count FROM task WHERE state='running'").get().count, 0)
  verify.close()
  process.stdout.write(`crash iterations=${String(ITERATIONS)} committed=${String(committed.size)} integrity=ok zombies=0 lost=0\n`)
} finally {
  await rm(directory, { recursive: true, force: true })
}

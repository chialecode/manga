import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'

const root = await mkdtemp(join(tmpdir(), 'packaged-svc-db-'))
const executable = join(process.cwd(), 'apps', 'desktop', 'out', 'manga-dev-win32-x64', 'manga-dev.exe')
const child = spawn(executable, [], {
  env: { ...process.env, APPDATA: join(root, 'roaming'), LOCALAPPDATA: join(root, 'local') },
  stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
})
let stderr = ''
child.stderr.on('data', (chunk) => { stderr += chunk.toString('utf8') })
try {
  const databasePath = join(root, 'roaming', 'manga-dev', 'data.sqlite')
  const deadlineMs = Date.now() + 20_000
  while (!existsSync(databasePath) && Date.now() < deadlineMs) await new Promise((resolve) => setTimeout(resolve, 100))
  assert.equal(existsSync(databasePath), true, `packaged svc-db did not create data.sqlite: ${stderr}`)
  const db = new Database(databasePath, { readonly: true })
  let integrity
  try { integrity = db.pragma('integrity_check', { simple: true }) } finally { db.close() }
  assert.equal(integrity, 'ok')
  process.stdout.write(`${JSON.stringify({ mainPid: child.pid, integrity, databaseCreated: true })}\n`)
} finally {
  if (child.pid !== undefined) spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true })
  if (!child.killed) child.kill()
  await new Promise((resolve) => setTimeout(resolve, 250))
  if (process.env.KEEP_PACKAGED_SMOKE_ROOT !== '1') await rm(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 250 })
  else process.stdout.write(`smoke root preserved: ${root}\n`)
}

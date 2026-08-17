import assert from 'node:assert/strict'
import { fork } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const directory = await mkdtemp(join(tmpdir(), 'svc-db-process-'))
try {
  const migrations = join(process.cwd(), 'packages', 'data', 'migrations')
  const child = fork(join(process.cwd(), 'apps', 'desktop', '.vite', 'build', 'svc-db.cjs'), [], {
    env: { ...process.env, SVC_DB_PATH: join(directory, 'db.sqlite'), SVC_DB_MIGRATIONS: migrations, SVC_DB_BACKUPS: join(directory, 'backups') },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  })
  let stderr = ''
  child.stderr?.on('data', (chunk) => { stderr += chunk.toString('utf8') })
  const ready = await new Promise((resolve, reject) => {
    child.once('error', reject)
    child.once('exit', (code) => { reject(new Error(`svc-db exited before ready (${String(code)}): ${stderr}`)) })
    child.on('message', (message) => { if (message?.type === 'ready') resolve(message) })
  })
  assert.ok(ready)
  const response = await new Promise((resolve, reject) => {
    child.once('error', reject)
    child.on('message', (message) => { if (message?.id === 'integrity') resolve(message) })
    child.send({ id: 'integrity', method: 'system.integrityCheck' })
  })
  assert.deepEqual(response, { id: 'integrity', ok: true, value: 'ok' })
  assert.notEqual(child.pid, process.pid)
  child.disconnect()
  await new Promise((resolve) => child.once('exit', resolve))
  process.stdout.write(`${JSON.stringify({ servicePid: child.pid, parentPid: process.pid, integrity: response.value })}\n`)
} finally {
  await rm(directory, { recursive: true, force: true })
}

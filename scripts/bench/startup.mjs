import { execFile, spawnSync } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { cpus, freemem, tmpdir, totalmem } from 'node:os'
import { join } from 'node:path'

const executable = process.argv[2]
if (!executable) throw new Error('Provide an executable built with BUILD_STARTUP_BENCHMARK=1')
const samplesMs = []
const markers = await mkdtemp(join(tmpdir(), 'startup-bench-'))
let cleanupError
try {
 for (let sample = 0; sample < 20; sample += 1) {
  await new Promise((resolve, reject) => {
    const marker = join(markers, `${String(sample)}.txt`)
    const startedAtMs = Date.now()
    const child = execFile(executable, { env: { ...process.env, APP_STARTUP_MARKER: marker }, windowsHide: true })
    const timeout = setTimeout(() => {
      child.kill()
      reject(new Error(`Startup sample ${String(sample)} timed out`))
    }, 10_000)
    const poll = setInterval(() => {
      void readFile(marker, 'utf8').then((value) => {
        if (!/^\d{13}$/u.test(value)) return
        samplesMs.push(Number(value) - startedAtMs)
        clearInterval(poll)
        clearTimeout(timeout)
        if (process.platform === 'win32' && child.pid !== undefined) spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true })
        else child.kill()
        resolve()
      }).catch(() => undefined)
    }, 10)
    child.on('error', (error) => {
      clearInterval(poll)
      clearTimeout(timeout)
      reject(error)
    })
  })
 }
} finally {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    try {
      await rm(markers, { recursive: true, force: true })
      break
    } catch (error) {
      if (attempt === 9) {
        cleanupError = error
        break
      }
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
  }
}
if (cleanupError) throw cleanupError
const sorted = samplesMs.toSorted((a, b) => a - b)
const p95Ms = sorted[Math.ceil(sorted.length * 0.95) - 1]
const result = {
  version: '0.0.1',
  samplesMs,
  p95Ms,
  thresholdMs: 1200,
  machine: { cpu: cpus()[0]?.model, logicalCpus: cpus().length, totalMemory: totalmem(), freeMemory: freemem() },
}
await writeFile('docs/bench/0.0.1.json', `${JSON.stringify(result, null, 2)}\n`)
process.stdout.write(`${JSON.stringify(result)}\n`)
if ((p95Ms ?? Number.POSITIVE_INFINITY) > 1200) process.exitCode = 1

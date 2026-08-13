import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const profile = await mkdtemp(join(tmpdir(), 'rpc-smoke-profile-'))
try {
  const electron = join(process.cwd(), 'node_modules', 'electron', 'dist', 'electron.exe')
  const entry = join(process.cwd(), 'apps', 'desktop', '.vite', 'build', 'rpc-smoke.cjs')
  const child = spawn(electron, [entry], { env: { ...process.env, LOCALAPPDATA: profile }, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
  let stdout = ''
  let stderr = ''
  child.stdout.on('data', (chunk) => { stdout += chunk.toString('utf8') })
  child.stderr.on('data', (chunk) => { stderr += chunk.toString('utf8') })
  const exitCode = await new Promise((resolve) => child.once('exit', resolve))
  assert.equal(exitCode, 0, stderr)
  const line = stdout.split(/\r?\n/u).find((value) => value.startsWith('RPC_SMOKE '))
  assert.ok(line, `Missing smoke result: ${stdout}\n${stderr}`)
  const result = JSON.parse(line.slice('RPC_SMOKE '.length))
  process.stdout.write(`${JSON.stringify(result)}\n`)
  assert.deepEqual(result.echo, { ok: true, value: { value: 'ok' } })
  assert.ok(result.cancellationMs <= 200, `cancellation took ${String(result.cancellationMs)} ms`)
  assert.equal(result.chunksAfterWait, result.chunksAtCancel)
  assert.ok(result.rssGrowthBytes < 10 * 1024 * 1024, `RSS grew ${String(result.rssGrowthBytes)} bytes`)
  assert.ok(result.slowConsumerReceived > 32, `producer stalled at ${String(result.slowConsumerReceived)} chunks`)
  assert.ok(result.slowConsumerConsumed >= 96, `slow consumer only processed ${String(result.slowConsumerConsumed)} chunks`)
  assert.equal(result.logContainsTraceId, true)
  await mkdir('docs/bench', { recursive: true })
  await writeFile('docs/bench/rpc-e9.json', `${JSON.stringify({ measuredAt: new Date().toISOString(), durationMs: 60000, ...result }, null, 2)}\n`)
} finally {
  await rm(profile, { recursive: true, force: true })
}

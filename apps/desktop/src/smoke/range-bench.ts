import assert from 'node:assert/strict'
import { stat } from 'node:fs/promises'
import { performance } from 'node:perf_hooks'
import { mediaResponse } from '../main/protocol/media.js'

async function main(): Promise<void> {
  const path = process.argv[2]
  if (!path) throw new Error('Provide a local benchmark file path of at least 64 MiB')
  const size = (await stat(path)).size
  const rangeBytes = 64 * 1024 * 1024
  if (size < rangeBytes) throw new Error('Benchmark file must be at least 64 MiB')

  const iterations = 32
  const setupLatenciesMs: number[] = []
  let bytes = 0
  const startedAtMs = performance.now()
  for (let iteration = 0; iteration < iterations; iteration += 1) {
    const offset = (iteration * rangeBytes) % (size - rangeBytes + 1)
    const requestStartedAtMs = performance.now()
    const response = await mediaResponse(path, `bytes=${String(offset)}-${String(offset + rangeBytes - 1)}`, `bench-${String(iteration)}`)
    setupLatenciesMs.push(performance.now() - requestStartedAtMs)
    assert.equal(response.status, 206)
    const reader = response.body?.getReader()
    assert.ok(reader)
    for (;;) {
      const chunk = await reader.read()
      if (chunk.done) break
      bytes += chunk.value.byteLength
    }
  }
  const elapsedMs = performance.now() - startedAtMs
  const throughputMbPerSecond = bytes / 1_000_000 / (elapsedMs / 1000)
  const averageRequestMs = setupLatenciesMs.reduce((sum, value) => sum + value, 0) / setupLatenciesMs.length
  const result = { size, bytes, iterations, elapsedMs, throughputMbPerSecond, averageRequestMs }
  process.stdout.write(`${JSON.stringify(result)}\n`)
  if (throughputMbPerSecond < 400 || averageRequestMs > 2) process.exitCode = 1
}

void main()

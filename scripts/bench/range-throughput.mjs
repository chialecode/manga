import { createReadStream } from 'node:fs'
import { open, stat } from 'node:fs/promises'
import { performance } from 'node:perf_hooks'

const path = process.argv[2]
if (!path) throw new Error('Provide a local benchmark file path')
const size = (await stat(path)).size
const startedAtMs = performance.now()
let bytes = 0
for await (const chunk of createReadStream(path)) bytes += chunk.length
const elapsedMs = performance.now() - startedAtMs
const throughputMbPerSecond = bytes / 1_000_000 / (elapsedMs / 1000)
const file = await open(path, 'r')
await file.close()
process.stdout.write(JSON.stringify({ size, elapsedMs, throughputMbPerSecond }) + '\n')

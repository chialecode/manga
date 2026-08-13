import assert from 'node:assert/strict'
import { writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { Supervisor } from '../../apps/desktop/src/main/supervisor/index.ts'

const supervisor = new Supervisor(resolve('apps/desktop/src/main/supervisor/job-object.ps1'))
const startedAtMs = Date.now()
const events = []
await supervisor.supervise(
  process.execPath,
  ['-e', 'setTimeout(() => process.exit(7), 200)'],
  { SystemRoot: process.env.SystemRoot ?? 'C:\\Windows' },
  { onEvent: (event) => { events.push({ ...event, elapsedMs: Date.now() - startedAtMs }) } },
)

assert.deepEqual(events.filter((event) => event.kind === 'restart').map((event) => event.delayMs), [1000, 2000, 4000])
assert.equal(events.filter((event) => event.kind === 'started').length, 4)
assert.equal(events.at(-1)?.kind, 'circuit-open')
const starts = events.filter((event) => event.kind === 'started').map((event) => event.elapsedMs)
assert.ok((starts[1] ?? 0) - (starts[0] ?? 0) >= 900)
assert.ok((starts[2] ?? 0) - (starts[1] ?? 0) >= 1900)
assert.ok((starts[3] ?? 0) - (starts[2] ?? 0) >= 3900)

const result = { policy: '1/2/4 seconds, then circuit open', events }
await writeFile('docs/bench/supervisor.json', `${JSON.stringify(result, null, 2)}\n`)
process.stdout.write(`${JSON.stringify(result)}\n`)

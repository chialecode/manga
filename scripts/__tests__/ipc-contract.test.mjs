import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { z } from 'zod'
import { ipcContractViolations } from '../lib/ipc-contract.mjs'
import { ipcSourceViolations } from '../lib/repository-guards.mjs'

const valid = {
  name: 'sys.echo',
  input: z.object({ value: z.string() }),
  output: z.object({ value: z.string() }),
}

test('registered contract has bidirectional schemas and no credentials', async () => {
  assert.deepEqual(ipcSourceViolations(await readFile('packages/contract/src/sys.ts', 'utf8')), [])
})

test('counterexample: method without schemas is rejected', () => {
  assert.match(ipcContractViolations([{ name: 'bad.method' }])[0] ?? '', /missing input schema/)
})

test('counterexample: credential output field is rejected', () => {
  const bad = { ...valid, output: z.object({ apiKey: z.string() }) }
  assert.match(ipcContractViolations([bad])[0] ?? '', /credential output field/)
})

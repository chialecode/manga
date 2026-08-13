import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { moduleBoundaryViolations } from '../lib/module-boundary.mjs'

test('repository obeys module boundaries', async () => {
  assert.deepEqual(await moduleBoundaryViolations(process.cwd()), [])
})

test('counterexample: domain Node import is rejected', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'module-boundary-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const directory = join(root, 'packages', 'domain', 'src')
  await mkdir(directory, { recursive: true })
  await writeFile(join(directory, 'bad.ts'), "import 'node:fs'\n")
  assert.match((await moduleBoundaryViolations(root))[0] ?? '', /domain cannot import node:fs/)
})

test('counterexample: features data import is rejected', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'module-boundary-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const directory = join(root, 'packages', 'features', 'src')
  await mkdir(directory, { recursive: true })
  await writeFile(join(directory, 'bad.ts'), "import '@manga/data'\n")
  assert.match((await moduleBoundaryViolations(root))[0] ?? '', /features cannot import data/)
})

import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { directImportViolations } from '../lib/static-guards.mjs'

const allowed = ['apps/desktop/src/main/capability-gate/', 'packages/data/']
test('filesystem imports stay behind admitted boundaries', async () => {
  assert.deepEqual(await directImportViolations(process.cwd(), 'node:fs', allowed), [])
})
test('counterexample: direct feature fs import is rejected', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'no-fs-')); t.after(() => rm(root, { recursive: true, force: true }))
  const dir = join(root, 'packages', 'features'); await mkdir(dir, { recursive: true }); await writeFile(join(dir, 'bad.ts'), "import 'node:fs'\n")
  assert.match((await directImportViolations(root, 'node:fs', allowed))[0] ?? '', /direct node:fs/)
})

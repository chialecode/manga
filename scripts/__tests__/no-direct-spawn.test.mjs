import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { directImportViolations } from '../lib/static-guards.mjs'

const allowed = ['apps/desktop/src/main/supervisor/']
test('child processes stay behind supervisor', async () => {
  assert.deepEqual(await directImportViolations(process.cwd(), 'node:child_process', allowed), [])
})
test('counterexample: direct child process import is rejected', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'no-spawn-')); t.after(() => rm(root, { recursive: true, force: true }))
  const dir = join(root, 'packages', 'media'); await mkdir(dir, { recursive: true }); await writeFile(join(dir, 'bad.ts'), "import 'node:child_process'\n")
  assert.match((await directImportViolations(root, 'node:child_process', allowed))[0] ?? '', /direct node:child_process/)
})

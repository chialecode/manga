import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { hardcodedCopyViolations } from '../lib/static-guards.mjs'

test('JSX has no hardcoded visible copy', async () => assert.deepEqual(await hardcodedCopyViolations(process.cwd()), []))
test('counterexample: visible JSX text is rejected', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'copy-')); t.after(() => rm(root, { recursive: true, force: true }))
  const dir = join(root, 'packages', 'features'); await mkdir(dir, { recursive: true }); await writeFile(join(dir, 'bad.tsx'), 'export const x = <div>Visible text</div>\n')
  assert.match((await hardcodedCopyViolations(root))[0] ?? '', /hardcoded JSX copy/)
})

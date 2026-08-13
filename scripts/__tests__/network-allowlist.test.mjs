import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { hardcodedUrlViolations } from '../lib/static-guards.mjs'

test('source has no hardcoded network URL', async () => assert.deepEqual(await hardcodedUrlViolations(process.cwd()), []))
test('counterexample: source URL literal is rejected', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'network-')); t.after(() => rm(root, { recursive: true, force: true }))
  const dir = join(root, 'packages', 'providers'); await mkdir(dir, { recursive: true }); await writeFile(join(dir, 'bad.ts'), "export const x = 'https://invalid.example'\n")
  assert.match((await hardcodedUrlViolations(root))[0] ?? '', /hardcoded URL/)
})

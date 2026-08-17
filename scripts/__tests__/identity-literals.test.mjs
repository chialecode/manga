import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { identityLiteralViolations } from '../lib/identity-literals.mjs'

test('runtime identity literals exist only in identity.ts', async () => {
  assert.deepEqual(await identityLiteralViolations(process.cwd()), [])
})

test('counterexample: duplicated app id is rejected', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'identity-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const dir = join(root, 'apps', 'desktop', 'src'); await mkdir(dir, { recursive: true })
  await writeFile(join(dir, 'bad.ts'), "export const id = 'app.manga.desktop'\n")
  await writeFile(join(root, 'apps', 'desktop', 'forge.config.mjs'), 'export default {}\n')
  assert.match((await identityLiteralViolations(root))[0] ?? '', /identity literal/)
})

import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { directImportViolations } from '../lib/static-guards.mjs'

const allowed = [
  'apps/desktop/src/main/capability-gate/',
  'apps/desktop/src/main/benchmark/', // Build-folded benchmark-only file output.
  'apps/desktop/src/main/logger/', // The structured logger owns its append-only log sink.
  'apps/desktop/src/main/vendor-bin.ts', // Startup integrity verification reads admitted artifacts.
  'apps/desktop/src/main/updater/transport.ts', // The updater owns its application staging file only.
  'apps/desktop/src/main/updater/__tests__/', // Test-only local HTTP fixtures.
  'apps/desktop/src/smoke/', // Test-only Electron smoke reads its own app log.
  'packages/data/',
]
test('filesystem imports stay behind admitted boundaries', async () => {
  assert.deepEqual(await directImportViolations(process.cwd(), 'node:fs', allowed), [])
})
test('counterexample: direct feature fs import is rejected', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'no-fs-')); t.after(() => rm(root, { recursive: true, force: true }))
  const dir = join(root, 'packages', 'features'); await mkdir(dir, { recursive: true }); await writeFile(join(dir, 'bad.ts'), "import 'node:fs'\n")
  assert.match((await directImportViolations(root, 'node:fs', allowed))[0] ?? '', /direct node:fs/)
})
for (const [name, source] of [
  ['promises subpath', "import { readFile } from 'node:fs/promises'\n"],
  ['dynamic import', "await import('node:fs')\n"],
  ['bare require', "require('fs/promises')\n"],
  ['createRequire', "createRequire(import.meta.url)('fs')\n"],
]) {
  test(`counterexample: ${name} is rejected`, async (t) => {
    const root = await mkdtemp(join(tmpdir(), 'no-fs-'))
    t.after(() => rm(root, { recursive: true, force: true }))
    const dir = join(root, 'packages', 'features')
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, 'bad.ts'), source)
    assert.match((await directImportViolations(root, 'node:fs', allowed))[0] ?? '', /direct node:fs/)
  })
}

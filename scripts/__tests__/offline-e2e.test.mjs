import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { OFFLINE_NETWORK_ALLOWLIST, offlineViolations, repositoryOfflineViolations } from '../lib/repository-guards.mjs'
test('Phase 1 runtime source has no outbound implementation', async () => assert.deepEqual(await repositoryOfflineViolations(process.cwd()), []))
test('counterexample: outbound fetch is rejected', () => assert.match(offlineViolations("fetch('x')")[0] ?? '', /outbound/))
test('network allowlist has one reasoned update transport entry', () => {
  assert.deepEqual(OFFLINE_NETWORK_ALLOWLIST, [{
    path: 'apps/desktop/src/main/updater/transport.ts',
    reason: 'User-triggered signed update transport; core offline workflows never call this module.',
  }])
})
test('counterexample: a second outbound source is rejected', async () => {
  const root = await mkdtemp(join(tmpdir(), 'offline-counterexample-'))
  try {
    const directory = join(root, 'apps', 'desktop', 'src', 'main', 'other-network')
    await mkdir(directory, { recursive: true })
    await writeFile(join(directory, 'index.ts'), "fetch('x')\n")
    assert.match((await repositoryOfflineViolations(root))[0] ?? '', /outbound/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

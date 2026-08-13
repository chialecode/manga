import assert from 'node:assert/strict'
import { readdir } from 'node:fs/promises'
import { join } from 'node:path'
import test from 'node:test'
import { FuseState, FuseV1Options } from '@electron/fuses'
import { fuseConfigViolations, packagedFuseViolations } from '../lib/security-assertions.mjs'

async function findExe(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) {
      const nested = await findExe(path)
      if (nested) return nested
    } else if (entry.name.endsWith('.exe')) return path
  }
}

test('packaged executable has all eight locked Fuses', async () => {
  const exe = await findExe(join(process.cwd(), 'apps', 'desktop', 'out'))
  assert.ok(exe, 'packaged Electron executable is required')
  assert.deepEqual(await packagedFuseViolations(exe), [])
})

test('counterexample: RunAsNode enabled is rejected', () => {
  const config = {
    [FuseV1Options.RunAsNode]: FuseState.ENABLE,
  }
  assert.match(fuseConfigViolations(config)[0] ?? '', /RunAsNode/)
})

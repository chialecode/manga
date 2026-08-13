import assert from 'node:assert/strict'
import { readdir } from 'node:fs/promises'
import { join } from 'node:path'
import test from 'node:test'
import { FuseState, FuseV1Options } from '@electron/fuses'
import { fuseConfigViolations, packagedFuseViolations } from '../lib/security-assertions.mjs'

// electron-packager writes one directory per platform target, with the app
// executable at its top level. Returning the first match of a recursive walk
// would silently validate a stale target left over from an earlier build, so
// every packaged executable is asserted instead.
async function packagedExecutables(outDirectory) {
  const executables = []
  for (const target of await readdir(outDirectory, { withFileTypes: true })) {
    if (!target.isDirectory() || target.name === 'make') continue
    const targetDirectory = join(outDirectory, target.name)
    for (const entry of await readdir(targetDirectory, { withFileTypes: true })) {
      if (entry.isFile() && entry.name.endsWith('.exe')) executables.push(join(targetDirectory, entry.name))
    }
  }
  return executables
}

test('every packaged executable has all eight locked Fuses', async () => {
  const executables = await packagedExecutables(join(process.cwd(), 'apps', 'desktop', 'out'))
  assert.ok(executables.length > 0, 'at least one packaged Electron executable is required')
  for (const executable of executables) {
    assert.deepEqual(await packagedFuseViolations(executable), [], executable)
  }
})

test('counterexample: RunAsNode enabled is rejected', () => {
  const config = {
    [FuseV1Options.RunAsNode]: FuseState.ENABLE,
  }
  assert.match(fuseConfigViolations(config)[0] ?? '', /RunAsNode/)
})

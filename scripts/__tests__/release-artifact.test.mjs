import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { releaseArtifactViolations } from '../lib/release-artifact.mjs'

test('release main bundle contains no startup benchmark switch', async () => {
  const source = await readFile('apps/desktop/.vite/build/main.cjs', 'utf8')
  assert.deepEqual(releaseArtifactViolations(source), [])
})

test('counterexample: a bundle containing the startup switch is rejected', () => {
  const source = 'const marker = process.env.APP_STARTUP_MARKER'
  assert.match(releaseArtifactViolations(source)[0] ?? '', /APP_STARTUP_MARKER/)
})

import assert from 'node:assert/strict'
import test from 'node:test'
import { offlineViolations, repositoryOfflineViolations } from '../lib/repository-guards.mjs'
test('Phase 1 runtime source has no outbound implementation', async () => assert.deepEqual(await repositoryOfflineViolations(process.cwd()), []))
test('counterexample: outbound fetch is rejected', () => assert.match(offlineViolations("fetch('x')")[0] ?? '', /outbound/))

import assert from 'node:assert/strict'
import test from 'node:test'
import { i18nViolations, repositoryI18nViolations } from '../lib/repository-guards.mjs'
test('three repository catalogs share a typed key set', async () => assert.deepEqual(await repositoryI18nViolations(process.cwd()), []))
test('counterexample: missing translation is rejected', () => assert.match(i18nViolations([['a','b'],['a']])[0] ?? '', /keys differ/))

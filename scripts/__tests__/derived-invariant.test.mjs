import assert from 'node:assert/strict'
import test from 'node:test'
import { derivedInvariantViolations, repositoryDerivedViolations } from '../lib/repository-guards.mjs'
test('repository contains no unlinked derived write', async () => assert.deepEqual(await repositoryDerivedViolations(process.cwd()), []))
test('counterexample: derived write without evidence is rejected', () => assert.match(derivedInvariantViolations('INSERT INTO transcript')[0] ?? '', /evidence_link/))

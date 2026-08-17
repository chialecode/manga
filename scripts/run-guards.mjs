import { spawnSync } from 'node:child_process'

const STATIC_GUARDS = [
  'module-boundary', 'no-direct-fs', 'no-direct-spawn', 'network-allowlist', 'no-hardcoded-copy',
  'i18n-complete', 'ipc-contract', 'migration-freeze', 'csp-assert', 'vendor-sha256',
  'third-party-notices',
  'no-bare-new-browserwindow', 'validate-migrations',
]
const RUNTIME_GUARDS = ['fuses-assert', 'migration-replay', 'log-redaction', 'derived-invariant', 'offline-e2e', 'release-artifact']
const group = process.argv[2]
if (group !== 'static' && group !== 'runtime') throw new Error('Expected static or runtime')

const guards = group === 'static' ? [...STATIC_GUARDS, 'identity-literals'] : RUNTIME_GUARDS
const files = guards.map((guard) => `scripts/__tests__/${guard}.test.mjs`)
const result = spawnSync(process.execPath, ['--test', ...files], { stdio: 'inherit' })
process.exit(result.status ?? 1)

export { RUNTIME_GUARDS, STATIC_GUARDS }

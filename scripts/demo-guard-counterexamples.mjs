import { spawnSync } from 'node:child_process'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { dirname } from 'node:path'
import Database from 'better-sqlite3'
import { FuseState, FuseV1Options } from '@electron/fuses'
import { ipcContractViolations } from './lib/ipc-contract.mjs'
import { migrationFreezeViolations } from './lib/migrations.mjs'
import { moduleBoundaryViolations } from './lib/module-boundary.mjs'
import { cspViolations, fuseConfigViolations } from './lib/security-assertions.mjs'
import { directImportViolations, hardcodedCopyViolations, hardcodedUrlViolations } from './lib/static-guards.mjs'
import { derivedInvariantViolations, i18nViolations, ipcSourceViolations, offlineViolations } from './lib/repository-guards.mjs'
import { vendorManifestViolations } from './lib/vendor.mjs'
import { migrationReplayViolations, redactionViolations, thirdPartyNoticeViolations } from './lib/runtime-guards.mjs'

const names = ['module-boundary','ipc-contract','derived-invariant','migration-freeze','migration-replay','network-allowlist','no-direct-fs','no-direct-spawn','csp-assert','fuses-assert','vendor-sha256','third-party-notices','log-redaction','offline-e2e','i18n-complete','no-hardcoded-copy']
const selected = process.argv[2]

if (selected) {
  const violations = await counterexample(selected)
  if (violations.length === 0) process.exit(0)
  process.stderr.write(`REJECTED ${selected}: ${violations.join('; ')}\n`)
  process.exit(1)
}

const evidence = []
for (const name of names) {
  const run = spawnSync(process.execPath, [import.meta.filename, name], { encoding: 'utf8' })
  const output = `${run.stdout}${run.stderr}`.trim()
  if (run.status === 0 || !output.includes(`REJECTED ${name}:`)) throw new Error(`${name} counterexample was not rejected: ${output}`)
  process.stdout.write(`${output}\n`)
  evidence.push({ guard: name, exitCode: run.status, evidence: output })
}
await mkdir('docs/acceptance', { recursive: true })
await writeFile('docs/acceptance/guard-counterexamples.json', `${JSON.stringify({ demonstratedAt: new Date().toISOString(), guards: evidence }, null, 2)}\n`)
process.stdout.write(`All ${String(evidence.length)} guard counterexamples were rejected.\n`)

async function counterexample(name) {
  if (name === 'module-boundary') return withSource('packages/domain/src/bad.ts', "import 'node:fs'\n", moduleBoundaryViolations)
  if (name === 'ipc-contract') return ipcContractViolations([{ name: 'bad.method' }])
  if (name === 'derived-invariant') return derivedInvariantViolations('INSERT INTO transcript(text) VALUES (?)')
  if (name === 'migration-freeze') {
    const root = await mkdtemp(join(tmpdir(), 'guard-migration-'))
    try { const dir=join(root,'m'); await mkdir(dir); await writeFile(join(dir,'0001_init.sql'),'tampered'); const lock=join(root,'lock.json'); await writeFile(lock,JSON.stringify({'0001_init.sql':'0'.repeat(64)})); return await migrationFreezeViolations(dir,lock) } finally { await rm(root,{recursive:true,force:true}) }
  }
  if (name === 'migration-replay') { const db=new Database(':memory:'); try { return migrationReplayViolations(db) } finally { db.close() } }
  if (name === 'network-allowlist') return withSource('packages/providers/bad.ts', "export const x='https://invalid.example'\n", hardcodedUrlViolations)
  if (name === 'no-direct-fs') return withSource('packages/features/bad.ts', "import 'node:fs'\n", (root) => directImportViolations(root,'node:fs',['apps/desktop/src/main/capability-gate/','packages/data/']))
  if (name === 'no-direct-spawn') return withSource('packages/media/bad.ts', "import 'node:child_process'\n", (root) => directImportViolations(root,'node:child_process',['apps/desktop/src/main/supervisor/']))
  if (name === 'csp-assert') return cspViolations({APP_CSP:["default-src 'none'"],BOOK_CSP:["script-src 'self'"]})
  if (name === 'fuses-assert') return fuseConfigViolations({ [FuseV1Options.RunAsNode]: FuseState.ENABLE })
  if (name === 'vendor-sha256') return vendorManifestViolations({ffmpeg:{url:'https://invalid/latest.zip',sourceUrl:'x',archiveSha256:'x',files:{}}})
  if (name === 'third-party-notices') return thirdPartyNoticeViolations('new lock','old notice')
  if (name === 'log-redaction') return redactionViolations({apiKey:'secret-value'}, ['secret-value'])
  if (name === 'offline-e2e') return offlineViolations("fetch('https://invalid.example')")
  if (name === 'i18n-complete') return i18nViolations([['a','b'],['a'],['a','b']])
  if (name === 'no-hardcoded-copy') return withSource('packages/features/bad.tsx','export const x=<div>Visible text</div>\n',hardcodedCopyViolations)
  return ipcSourceViolations("method({ name: 'bad.method' })")
}

async function withSource(relative, source, check) {
  const root = await mkdtemp(join(tmpdir(), 'guard-demo-'))
  try { const file=join(root,relative); await mkdir(dirname(file),{recursive:true}); await writeFile(file,source); return await check(root) } finally { await rm(root,{recursive:true,force:true}) }
}

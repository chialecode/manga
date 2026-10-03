import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { m1bFingerprints } from '../../../../scripts/m1b-fingerprint.mjs';
import { evaluateM1bEvidence } from '../../../../scripts/m1b-report.mjs';
const root = process.cwd(), dir = path.dirname(fileURLToPath(import.meta.url));
const read = name => JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8'));
const write = (name, value) => fs.writeFileSync(path.join(dir, name), JSON.stringify(value, null, 2) + '\n');
const git = (...args) => execFileSync('git', args, { encoding: 'utf8' }).trim();
const base = '05be466e0d93319129f4ae96983b653fd8a3e18a';
const fingerprints = m1bFingerprints(root);
const sources = ['a-recheck-original.json', 'a-pdfjs-review.json', 'a-supplemental-review.json'];
const observations = sources.flatMap(name => {
  const result = read(name);
  for (const [key, value] of Object.entries(fingerprints)) assert.equal(result[key], value, `${name}:${key}`);
  return result.observations.map(row => ({ ...row, evidence: name }));
});
write('a-adversarial-review.json', { at: new Date().toISOString(), ...fingerprints, status: observations.every(row => row.status === 'passed') ? 'passed' : 'rework-required', productAcceptance: 'not-run', humanChecks: 'not-run', observations });
const strict = evaluateM1bEvidence(dir, fingerprints, { requirePdfCounterexamples: true });
write('report.json', { ...strict, ...fingerprints, at: new Date().toISOString() });

const groups = ['docs/evidence/m1b-reading-notes', 'docs/evidence/m1b-m1a-regression'];
const entries = git('ls-tree', '-r', base, '--', ...groups).split('\n').filter(Boolean).map(row => {
  const [, expected, file] = /^\d+ blob (\w+)\t(.+)$/.exec(row);
  return { expected, file };
});
const hashes = execFileSync('git', ['hash-object', '--stdin-paths'], { input: entries.map(row => row.file).join('\n') + '\n', encoding: 'utf8' }).trim().split('\n');
entries.forEach((row, index) => assert.equal(hashes[index], row.expected, row.file));
const protectedDirectories = [...new Set(entries.map(row => row.file.split('/').slice(0, 4).join('/')))];
const protectedResults = protectedDirectories.map(directory => ({ directory, files: entries.filter(row => row.file.startsWith(directory + '/')).length, unchanged: true }));
const require = createRequire(import.meta.url), asar = require('@electron/asar');
const pack = 'dist/desktop/packages/MANGA-win32-x64';
const archive = path.join(pack, 'resources/app.asar');
const files = asar.listPackage(archive).map(name => name.replaceAll('\\', '/'));
const sha = file => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const offlineAssets = [];
for (const kind of ['cmaps', 'standard_fonts', 'wasm', 'iccs', 'legacy/build']) {
  const target = path.join(pack, 'resources/pdfjs', kind);
  const assets = fs.readdirSync(target, { withFileTypes: true }).filter(row => row.isFile());
  for (const entry of assets) assert.equal(sha(path.join(target, entry.name)), sha(path.join('node_modules/pdfjs-dist', kind, entry.name)));
  offlineAssets.push({ kind, files: assets.length, installedBytesMatch: true });
}
const licenseMatch = sha(path.join(pack, 'resources/pdfjs/LICENSE')) === sha('node_modules/pdfjs-dist/LICENSE');
assert.ok(licenseMatch);
const baseline = read('baseline/a-pdfjs-review.json');
assert.equal(fingerprints.lockFingerprint, baseline.lockFingerprint);
assert.equal(fingerprints.buildScriptFingerprint, baseline.buildScriptFingerprint);
const fixes = git('diff', '--name-only', base, '--', 'packages', 'apps', 'scripts', 'tests').split('\n').filter(Boolean);
// New regression is untracked until the final staging step, so include it independently of Git's index.
if (!fixes.includes('tests/m1b/pdf-page-lifecycle.test.tsx')) fixes.push('tests/m1b/pdf-page-lifecycle.test.tsx');
write('integrity.json', {
  at: new Date().toISOString(), reviewedCommit: base, parent: git('rev-parse', base + '^'), ...fingerprints,
  sameSourceAsB: false, reason: 'Agent A fixed late TextLayer publication and pending in-flight cancellation; required tests use existing G-01 and AT-04 identifiers.',
  localReviewFixes: fixes,
  protectedCommits: ['1919dc4', 'bd1fcbe', 'c692f58'].map(ref => ({ commit: git('rev-parse', ref), ancestorOfReviewedCommit: execFileSync('git', ['merge-base', '--is-ancestor', ref, base]).length === 0 })),
  protectedResults, protectedFiles: entries.length,
  package: { path: pack, asarSha256: sha(archive), executableSha256: sha(path.join(pack, 'MANGA.exe')), offlineAssets, licenseMatch, rendererAssets: files.filter(name => name.includes('/pdfjs/')).length, pdfWorker: files.filter(name => /pdf\.worker.*\.mjs$/.test(name)), oldPdfSourceRemoved: !fs.existsSync('packages/app-core/src/domain/pdf-text.ts') },
  reviewScripts: fs.readdirSync(dir).filter(name => name.endsWith('.mjs')).map(name => ({ name, sha256: sha(path.join(dir, name)) })),
  ci: read('ci-status.json'), productAcceptance: 'not-run', formalH: 'not-run', q08: 'not-run', realModels: 'not-run', realProfileMigration: 'not-run',
});
console.log(JSON.stringify({ engineeringReviewable: strict.engineeringReviewable, errors: strict.errors, protectedFiles: entries.length }, null, 2));
if (!strict.engineeringReviewable) process.exitCode = 1;

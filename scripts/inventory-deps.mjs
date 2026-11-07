// Dependency inventory (U1, LOOP-02).
// Enumerates the direct dependencies of every workspace manifest, queries the npm registry for the
// current latest stable version of each, and classifies how the dependency is consumed. The result
// feeds LOOP-02 (no-immediate-need major migrations) and the Q-14 engine recommendation; it is a
// snapshot, not an upgrade log.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { loadStage, stageFingerprints } from './stage/lib.mjs';
import { repoRoot, evidenceRunDir } from './desktop-paths.ts';

// Run output stays under dist/; the delivery report copies the final result it needs.
const evidence = process.env.DEPS_EVIDENCE_DIR ? path.resolve(repoRoot, process.env.DEPS_EVIDENCE_DIR) : evidenceRunDir('m2', 'deps');
fs.mkdirSync(evidence, { recursive: true });

const manifests = [
  { name: 'root', file: 'package.json', kind: 'workspace-root' },
  { name: '@manga/desktop', file: 'apps/desktop/package.json', kind: 'desktop-shell' },
  ...fs.readdirSync(path.join(repoRoot, 'packages')).map((dir) => ({ name: dir, file: `packages/${dir}/package.json`, kind: 'workspace-package' })),
  { name: 'experiments/m0', file: 'experiments/m0/package.json', kind: 'prototype-registered-workspace' },
];

// A direct dependency is "consumed by product code" when some non-test source file imports it.
const sourceDirs = ['packages/app-core/src', 'packages/contracts/src', 'packages/i18n/src', 'packages/kernel/src', 'packages/model-protocol/src', 'packages/plugin-sdk/src', 'packages/storage-drizzle/src', 'packages/storage-sqlite/src', 'apps/desktop/src'];
const productSource = sourceDirs.map((dir) => {
  const root = path.join(repoRoot, dir);
  const walk = (current) => (fs.existsSync(current) ? fs.readdirSync(current, { withFileTypes: true }).flatMap((entry) => {
    const next = path.join(current, entry.name);
    return entry.isDirectory() ? walk(next) : entry.name.endsWith('.ts') || entry.name.endsWith('.tsx') ? [next] : [];
  }) : []);
  return walk(root);
}).flat();
const consumedByProduct = (name) => productSource.some((file) => fs.readFileSync(file, 'utf8').match(new RegExp(`from ["']${name.replace(/\//g, '\\/')}(?:/|["']|\\.js)`)));

const versionCache = new Map();
function latestVersion(name) {
  if (!versionCache.has(name)) {
    try {
      const out = execFileSync('npm', ['view', name, 'version'], { encoding: 'utf8', timeout: 60_000, shell: process.platform === 'win32' });
      versionCache.set(name, out.trim().split('\n').pop()?.trim() ?? null);
    } catch (error) {
      versionCache.set(name, `query-failed: ${String(error.message).slice(0, 80)}`);
    }
  }
  return versionCache.get(name);
}

const rows = [];
const lockfile = fs.existsSync(path.join(repoRoot, 'pnpm-lock.yaml'));
for (const manifest of manifests) {
  const file = path.join(repoRoot, manifest.file);
  if (!fs.existsSync(file)) continue;
  const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  for (const section of ['dependencies', 'devDependencies']) {
    for (const [name, range] of Object.entries(parsed[section] ?? {})) {
      const latest = name.startsWith('@manga/') || range.startsWith('workspace:') ? 'workspace' : latestVersion(name);
      const installed = range.startsWith('workspace:') ? 'workspace' : range.replace(/^[\^~>=< ]+/, '');
      rows.push({
        manifest: manifest.name,
        kind: manifest.kind,
        section,
        name,
        range,
        installed,
        latestStable: latest,
        upToDate: latest === 'workspace' ? null : installed === latest,
        majorBehind: latest === 'workspace' || installed === latest ? null : installed.split('.')[0] !== latest.split('.')[0],
        consumedByProductSource: name.startsWith('@manga/') ? null : consumedByProduct(name),
        role: name === 'pdfjs-dist' ? 'PDF text layer and page rendering (product, pinned; assets bundled unpacked)' : undefined,
      });
    }
  }
}

const behind = rows.filter((row) => row.upToDate === false);
const report = {
  at: new Date().toISOString(),
  kind: 'dependency-inventory',
  lockfilePresent: lockfile,
  node: process.version,
  pnpm: '11.24.0 (packageManager field)',
  counts: { manifests: manifests.filter((manifest) => fs.existsSync(path.join(repoRoot, manifest.file))).length, rows: rows.length, upToDate: rows.filter((row) => row.upToDate === true).length, behind: behind.length, workspace: rows.filter((row) => row.upToDate === null).length },
  classification: {
    installedVerified: 'M2 Vitest + packaging gates exercise the listed runtime deps on this commit',
    exceptions: 'a dependency behind its latest major stays only with a recorded reason and retest condition in the delivery report (LOOP-02)',
    loop02: 'major-behind entries are listed in the delivery report with their reason',
  },
  behind,
  rows,
  ...stageFingerprints(repoRoot, loadStage('m2')),
  scriptFingerprint: createHash('sha256').update(fs.readFileSync(fileURLToPath(import.meta.url))).digest('hex'),
  productAcceptance: 'not-run',
};
fs.writeFileSync(path.join(evidence, 'dependency-inventory.json'), JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify({ status: 'written', counts: report.counts, behind: behind.map((row) => `${row.name} ${row.installed} -> ${row.latestStable}`) }, null, 2));

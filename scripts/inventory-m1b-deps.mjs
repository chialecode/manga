// D0 dependency inventory (唯一计划第 12.1 节 / 第 13 节 D0 行).
// Enumerates the direct dependencies of every workspace manifest, queries the npm registry for the
// current latest stable version of each, and classifies how the dependency is consumed. The result
// feeds LOOP-02 (no-immediate-need major migrations) and the Q-14 engine recommendation; it is a
// snapshot, not an upgrade log.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { m1bFingerprints } from './m1b-fingerprint.mjs';
import { repoRoot } from './desktop-paths.ts';

const evidence = path.resolve(repoRoot, process.env.M1B_EVIDENCE_DIR ?? 'docs/evidence/m1b-reading-notes/b9-rework');
fs.mkdirSync(evidence, { recursive: true });

const manifests = [
  { name: 'root', file: 'package.json', kind: 'workspace-root' },
  { name: '@manga/desktop', file: 'apps/desktop/package.json', kind: 'desktop-shell' },
  ...fs.readdirSync(path.join(repoRoot, 'packages')).map((dir) => ({ name: dir, file: `packages/${dir}/package.json`, kind: 'workspace-package' })),
  { name: 'experiments/m0', file: 'experiments/m0/package.json', kind: 'prototype-registered-workspace' },
  { name: 'experiments/m0-desktop', file: 'experiments/m0-desktop/package.json', kind: 'prototype-independent-lockfile' },
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
        role: name === 'pdfjs-dist' ? 'reader-engine candidate prototype (Q-14, accepted=false, tests only)'
          : name === 'epubjs' ? 'EPUB engine comparison candidate (Q-14, accepted=false, tests only)'
          : name === '@readium/shared' ? 'EPUB engine comparison candidate (Q-14, accepted=false, tests only)'
          : undefined,
      });
    }
  }
}

const behind = rows.filter((row) => row.upToDate === false);
const report = {
  at: new Date().toISOString(),
  kind: 'd0-dependency-inventory',
  lockfilePresent: lockfile,
  node: process.version,
  pnpm: '11.24.0 (packageManager field)',
  counts: { manifests: manifests.filter((manifest) => fs.existsSync(path.join(repoRoot, manifest.file))).length, rows: rows.length, upToDate: rows.filter((row) => row.upToDate === true).length, behind: behind.length, workspace: rows.filter((row) => row.upToDate === null).length },
  classification: {
    installedVerified: 'M1b Vitest + packaging gates exercise the listed runtime deps on this commit',
    engineCandidates: 'pdfjs-dist / epubjs / @readium/shared are devDependencies used only by the reader-engine prototype and its audit; accepted=false',
    loop02: 'major-behind entries without an immediate need stay on LOOP-02 (plan §13) and are re-evaluated before the M1 engineering release gate',
  },
  behind,
  rows,
  ...m1bFingerprints(repoRoot),
  scriptFingerprint: createHash('sha256').update(fs.readFileSync(fileURLToPath(import.meta.url))).digest('hex'),
  productAcceptance: 'not-run',
};
fs.writeFileSync(path.join(evidence, 'dependency-inventory.json'), JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify({ status: 'written', counts: report.counts, behind: behind.map((row) => `${row.name} ${row.installed} -> ${row.latestStable}`) }, null, 2));

// B11 review runner. Writes only this run's evidence and does not touch earlier directories.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { m1bFingerprints } from '../../../../scripts/m1b-fingerprint.mjs';

const root = process.cwd();
const dir = path.dirname(fileURLToPath(import.meta.url));
const relative = p => path.relative(root, p).replaceAll('\\', '/');
const logs = path.join(root, 'dist/desktop/review-runs/b11-pdfjs-text');
fs.mkdirSync(logs, { recursive: true });
const env = { ...process.env, M1B_EVIDENCE_DIR: relative(dir), M1A_EVIDENCE_DIR: 'docs/evidence/m1b-m1a-regression/b11-pdfjs-text' };
delete env.M1B_REQUIRE_REPORT;
delete env.M1B_NODE_ONLY;
const record = path.join(dir, 'a-command-results.json');
const commands = fs.existsSync(record) ? JSON.parse(fs.readFileSync(record, 'utf8')) : [];
function run(file, extraEnv = {}) {
  const log = path.join(logs, `${path.basename(file, '.mjs')}-${commands.length + 1}.log`);
  const fd = fs.openSync(log, 'w');
  const start = new Date().toISOString();
  const result = spawnSync(process.execPath, [file], { cwd: root, env: { ...env, ...extraEnv }, stdio: ['ignore', fd, fd], windowsHide: true });
  fs.closeSync(fd);
  const row = { command: `node ${file}`, start, end: new Date().toISOString(), exitCode: result.status, log: relative(log), ...m1bFingerprints(root) };
  commands.push(row);
  fs.writeFileSync(record, JSON.stringify(commands, null, 2) + '\n');
  console.log(JSON.stringify({ command: row.command, exitCode: row.exitCode }));
  if (result.status !== 0) process.exitCode = 1;
  return result.status;
}
const phase = process.argv[2];
if (phase === 'legacy') {
  for (const name of ['standard-scan.pdf', 'relative-image.epub']) fs.copyFileSync(path.join(dir, '../a-b9-rework-review', name), path.join(dir, name));
  for (const name of ['consecutive-text.pdf', 'white-text.pdf']) fs.copyFileSync(path.join(dir, '../a-b10-review', name), path.join(dir, name));
  for (const name of ['review-m1b-a-b8', 'audit-m1b-b6-review', 'audit-m1b-recheck', 'review-m1b-a-b7-ui', 'review-m1b-ui', 'review-m1b-reading', 'review-m1b-recheck', 'review-m1b-b6-ui', 'review-m1b-b5-h-checks']) run(`scripts/${name}.mjs`);
  fs.copyFileSync(path.join(dir, 'a-adversarial-review.json'), path.join(dir, 'a-recheck-original.json'));
} else if (phase === 'adapted') {
  for (const name of ['review-m1b-a-b8', 'review-m1b-a-b7-ui', 'review-m1b-recheck']) run(`scripts/${name}.mjs`);
} else if (phase === 'new') {
  process.exitCode = run(relative(path.join(dir, 'independent-review.mjs')));
} else if (phase === 'm1a') {
  process.exitCode = run('scripts/audit-m1a-reverify.mjs');
} else if (phase === 'strict') {
  const files = ['a-recheck-original.json', 'a-pdfjs-review.json'];
  const observations = files.flatMap(name => JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8')).observations.map(row => ({ ...row, evidence: name })));
  const audit = { at: new Date().toISOString(), ...m1bFingerprints(root), status: observations.every(row => row.status === 'passed') ? 'passed' : 'rework-required', productAcceptance: 'not-run', humanChecks: 'not-run', observations };
  fs.writeFileSync(path.join(dir, 'a-adversarial-review.json'), JSON.stringify(audit, null, 2) + '\n');
  process.exitCode = run('scripts/verify-m1b.mjs', { M1B_REQUIRE_REPORT: '1' });
} else if (phase === 'repository') {
  const exitCode = run('scripts/verify.mjs');
  fs.writeFileSync(path.join(dir, 'repository-quality.json'), JSON.stringify({ at: new Date().toISOString(), ...m1bFingerprints(root), command: 'node scripts/verify.mjs', exitCode, status: exitCode === 0 ? 'passed' : 'failed', productAcceptance: 'not-run', ci: 'not-run' }, null, 2) + '\n');
  process.exitCode = exitCode;
} else throw new Error('expected legacy, adapted, new, m1a, strict or repository');

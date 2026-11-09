import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { findUncommentedSmokeSleeps } from './stage/lib.mjs';

// One offline entry point shared by developers, the optional hook and CI.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let failed = false;
// --skip-tests: everything but the Vitest run, for `node scripts/stage.mjs gate`, whose next step runs every test (with the large files on) on the
// same tree. Developers, the pre-push hook and CI run verify whole.
const skipTests = process.argv.includes('--skip-tests');
function run(command, args) {
  const result = spawnSync(command, args, { cwd: root, stdio: 'inherit' });
  if (result.error || result.status !== 0) {
    console.error(`FAILED ${path.basename(command)} ${args.join(' ')}${result.error ? `: ${result.error.message}` : ''}`);
    failed = true;
  }
}

if (Number(process.versions.node.split('.')[0]) < 24) {
  console.error('Node.js 24 or newer is required. CI uses .node-version.');
  process.exit(1);
}

for (const name of fs.readdirSync(path.join(root, 'scripts')).filter(name => name.endsWith('.mjs')).sort()) {
  run(process.execPath, ['--check', `scripts/${name}`]);
}
for (const name of [
  'docs/governance/document-registry.json',
  '.github/rulesets/main.json',
  '.github/repository-settings.json',
  '.github/actions-policy.json',
]) {
  try { JSON.parse(fs.readFileSync(path.join(root, name), 'utf8')); }
  catch (error) { console.error(`FAILED ${name}: ${error.message}`); failed = true; }
}
run(process.execPath, ['scripts/check-docs.mjs']);
run(process.execPath, ['--test', 'scripts/check-publication.test.mjs']);
run(process.execPath, ['--test', 'scripts/check-docs.test.mjs']);
run(process.execPath, ['--test', 'scripts/stage-report.test.mjs']);
run(process.execPath, ['--test', 'scripts/pre-push.test.mjs']);
run(process.execPath, ['scripts/check-publication.mjs']);
run(process.execPath, ['scripts/check-workflows.mjs']);
// The pinned tool downloads must stay downloadable: a month-end FFmpeg build and commit-hash pins (offline; the release
// workflow and the pre-push check also send HEAD requests).
run(process.execPath, ['scripts/tools/check-tool-links.mjs', '--pins']);
const uncommentedSleeps = findUncommentedSmokeSleeps();
if (uncommentedSleeps.length > 0) {
  console.error(`FAILED smoke sleep check: ${uncommentedSleeps.length} uncommented sleep( calls in apps/desktop/src/main/smoke:\n  ${uncommentedSleeps.join('\n  ')}`);
  failed = true;
}
if (fs.existsSync(path.join(root, 'pnpm-workspace.yaml'))) {
  run(process.execPath, ['scripts/check-deps.mjs']);
  const tscJs = path.join(root, 'node_modules/typescript/bin/tsc');
  if (!fs.existsSync(path.join(root, 'node_modules'))) {
    console.error('FAILED application typecheck: node_modules missing; run pnpm install');
    failed = true;
  } else if (fs.existsSync(tscJs)) {
    run(process.execPath, [tscJs, '--noEmit', '-p', 'tsconfig.json']);
    const desktopTsconfig = path.join(root, 'apps/desktop/tsconfig.json');
    if (fs.existsSync(desktopTsconfig)) {
      run(process.execPath, [tscJs, '--noEmit', '-p', 'apps/desktop/tsconfig.json']);
    }
    // Files, exports and dependencies nothing uses (knip.json names the entry points it cannot find on its own).
    const knip = path.join(root, 'node_modules/knip/bin/knip.js');
    if (!fs.existsSync(knip)) {
      console.error('FAILED unused code: knip is not installed');
      failed = true;
    } else {
      run(process.execPath, [knip, '--no-progress']);
    }
    const vitest = path.join(root, 'node_modules/vitest/vitest.mjs');
    if (skipTests) {
      console.log('tests skipped (--skip-tests): node scripts/stage.mjs test runs them');
    } else if (!fs.existsSync(vitest)) {
      console.error('FAILED tests: vitest is not installed');
      failed = true;
    } else {
      run(process.execPath, [vitest, 'run', '--config', 'vitest.config.ts']);
    }
  } else {
    console.error('FAILED application typecheck: tsc is not installed');
    failed = true;
  }
}
run('git', ['diff', '--check']);
run('git', ['diff', '--cached', '--check']);
console.log(JSON.stringify({ status: failed ? 'failed' : 'passed', check: 'repository-quality', node: process.versions.node }));
process.exitCode = failed ? 1 : 0;

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

// One offline entry point shared by developers, the optional hook and CI.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let failed = false;
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
run(process.execPath, ['--test', 'scripts/m0-report.test.mjs']);
run(process.execPath, ['--test', 'scripts/m1a-report.test.mjs']);
run(process.execPath, ['scripts/check-publication.mjs']);
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
    const vitest = path.join(root, 'node_modules/vitest/vitest.mjs');
    if (!fs.existsSync(vitest)) {
      console.error('FAILED m1a tests: vitest is not installed');
      failed = true;
    } else {
      run(process.execPath, [vitest, 'run', '--config', 'vitest.config.ts']);
    }
    run(process.execPath, ['--test', '--test-concurrency=1', 'experiments/m0/src/tests/poc-contract-schema.test.ts', 'experiments/m0/src/tests/review-regressions.test.ts', 'experiments/m0/src/tests/closure-review.test.ts']);
  } else {
    console.error('FAILED application typecheck: tsc is not installed');
    failed = true;
  }
}
run('git', ['diff', '--check']);
run('git', ['diff', '--cached', '--check']);
console.log(JSON.stringify({ status: failed ? 'failed' : 'passed', check: 'repository-quality', node: process.versions.node }));
process.exitCode = failed ? 1 : 0;

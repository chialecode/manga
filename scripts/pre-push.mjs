import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';

// The pre-push hook runs static verification (`verify.mjs --skip-tests`) plus `vitest related` for files changed
// relative to `origin/main` (falling back to full `verify.mjs` when shared test/workspace config changes or
// `MANGA_PRE_PUSH_FULL=1` is set). Complete output is kept so a one-off failure can be diagnosed later.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const KEEP = 10;

const FULL_TRIGGER_PATHS = new Set([
  'package.json',
  'pnpm-lock.yaml',
  'pnpm-workspace.yaml',
  'tsconfig.json',
  'vitest.config.ts',
  'scripts/verify.mjs',
  'scripts/pre-push.mjs',
]);

/** Decide whether the changed repository-relative file list requires the full Vitest suite instead of `vitest related`. */
export function planPrePushTests(changedFiles, { forceFull = false } = {}) {
  if (forceFull || !Array.isArray(changedFiles)) return { mode: 'full', files: [] };
  const normalized = [...new Set(changedFiles.map((file) => String(file).replaceAll('\\', '/').trim()).filter(Boolean))];
  if (normalized.some((file) => FULL_TRIGGER_PATHS.has(file) || file.startsWith('tests/helpers/'))) {
    return { mode: 'full', files: normalized };
  }
  const codeFiles = normalized.filter((file) => /\.(c|m)?(t|j)sx?$/.test(file));
  if (codeFiles.length === 0) return { mode: 'skip', files: [] };
  return { mode: 'related', files: codeFiles };
}

/** Files changed between `origin/main` (or `HEAD~1`) and `HEAD`, plus working-tree edits, or `null` if git diff fails. */
function collectChangedFiles(cwd = root) {
  const git = (args) => spawnSync('git', args, { cwd, encoding: 'utf8' });
  const base = git(['merge-base', 'HEAD', 'origin/main']);
  const ref = base.status === 0 && base.stdout.trim() ? base.stdout.trim() : 'HEAD~1';
  const committed = git(['diff', '--name-only', `${ref}...HEAD`]);
  if (committed.status !== 0) return null;
  const unstaged = git(['diff', '--name-only', 'HEAD']);
  const names = [
    ...committed.stdout.split('\n'),
    ...(unstaged.status === 0 ? unstaged.stdout.split('\n') : []),
  ];
  return [...new Set(names.map((name) => name.trim()).filter(Boolean))].filter((name) => fs.existsSync(path.join(cwd, name)));
}

/** Runs a command, mirrors its output to the terminal and writes all of it to the log file. Resolves with the exit code. */
export function runLogged(command, args, { cwd = root, logFile, mirror = true, append = false } = {}) {
  fs.mkdirSync(path.dirname(logFile), { recursive: true });
  const log = fs.createWriteStream(logFile, { flags: append ? 'a' : 'w' });
  log.write(`$ ${path.basename(command)} ${args.join(' ')}\nstarted ${new Date().toISOString()}\n\n`);
  return new Promise((resolve) => {
    const child = spawn(command, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    const forward = (chunk, stream) => { log.write(chunk); if (mirror) stream.write(chunk); };
    child.stdout.on('data', (chunk) => forward(chunk, process.stdout));
    child.stderr.on('data', (chunk) => forward(chunk, process.stderr));
    let finished = false;
    const finish = (code, note) => {
      if (finished) return; // a spawn failure reports both 'error' and 'close'
      finished = true;
      log.end(`\n${note}exit ${code} at ${new Date().toISOString()}\n`, () => resolve(code));
    };
    child.on('error', (error) => finish(1, `could not start: ${error.message}\n`));
    child.on('close', (code, signal) => finish(code ?? 1, signal ? `killed by ${signal}\n` : ''));
  });
}

/** Keeps the newest `keep` hook logs and removes the rest. */
export function pruneLogs(dir, keep = KEEP) {
  const logs = fs.existsSync(dir) ? fs.readdirSync(dir).filter((name) => /^pre-push-.*\.log$/.test(name)).sort() : [];
  for (const name of logs.slice(0, Math.max(0, logs.length - keep))) fs.rmSync(path.join(dir, name), { force: true });
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const dir = path.join(root, 'dist/evidence-runs');
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const logFile = path.join(dir, `pre-push-${stamp}.log`);
  const forceFull = process.env.MANGA_PRE_PUSH_FULL === '1';
  const plan = planPrePushTests(forceFull ? null : collectChangedFiles(root), { forceFull });
  let code = 0;
  if (plan.mode === 'full') {
    code = await runLogged(process.execPath, ['scripts/verify.mjs'], { logFile });
  } else {
    code = await runLogged(process.execPath, ['scripts/verify.mjs', '--skip-tests'], { logFile });
    if (code === 0 && plan.mode === 'related') {
      const vitest = path.join(root, 'node_modules/vitest/vitest.mjs');
      if (!fs.existsSync(vitest)) {
        console.error('FAILED tests: vitest is not installed');
        code = 1;
      } else {
        code = await runLogged(
          process.execPath,
          [vitest, 'related', '--run', '--config', 'vitest.config.ts', '--passWithNoTests', ...plan.files],
          { logFile, append: true },
        );
      }
    }
  }
  pruneLogs(dir);
  const shown = path.relative(root, logFile).split(path.sep).join('/');
  if (code !== 0) console.error(`pre-push verification failed (exit ${code}); the complete output is in ${shown}`);
  process.exit(code);
}

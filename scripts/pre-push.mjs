import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';

// The pre-push hook runs the full verification and keeps its complete output, so a one-off failure can be diagnosed
// later instead of from the last few lines of the terminal.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const KEEP = 10;

/** Runs a command, mirrors its output to the terminal and writes all of it to the log file. Resolves with the exit code. */
export function runLogged(command, args, { cwd = root, logFile, mirror = true } = {}) {
  fs.mkdirSync(path.dirname(logFile), { recursive: true });
  const log = fs.createWriteStream(logFile);
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
  const code = await runLogged(process.execPath, ['scripts/verify.mjs'], { logFile });
  pruneLogs(dir);
  const shown = path.relative(root, logFile).split(path.sep).join('/');
  if (code !== 0) console.error(`pre-push verification failed (exit ${code}); the complete output is in ${shown}`);
  process.exit(code);
}

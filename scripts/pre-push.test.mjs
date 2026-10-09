import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pruneLogs, runLogged } from './pre-push.mjs';

const dir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'manga-hook-'));

test('the log keeps the complete output of a failing run, not just its tail', async () => {
  const tmp = dir();
  try {
    const logFile = path.join(tmp, 'logs/pre-push-a.log');
    const script = "for (let i = 0; i < 200; i++) console.log('line ' + i); console.error('boom'); process.exit(3);";
    const code = await runLogged(process.execPath, ['-e', script], { cwd: tmp, logFile, mirror: false });
    assert.equal(code, 3);
    const text = fs.readFileSync(logFile, 'utf8');
    assert.ok(text.includes('line 0\n') && text.includes('line 199\n'));
    assert.ok(text.includes('boom'));
    assert.match(text, /exit 3 at /);
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});

test('a command that cannot start is a failure with a reason in the log', async () => {
  const tmp = dir();
  try {
    const logFile = path.join(tmp, 'pre-push-b.log');
    const code = await runLogged(path.join(tmp, 'missing-binary'), [], { cwd: tmp, logFile, mirror: false });
    assert.equal(code, 1);
    assert.match(fs.readFileSync(logFile, 'utf8'), /could not start/);
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});

test('only the newest logs are kept, and other files are left alone', () => {
  const tmp = dir();
  try {
    for (let i = 0; i < 12; i++) fs.writeFileSync(path.join(tmp, `pre-push-2026-01-${String(i + 10).padStart(2, '0')}.log`), 'x');
    fs.writeFileSync(path.join(tmp, 'other.log'), 'x');
    pruneLogs(tmp, 10);
    const left = fs.readdirSync(tmp).sort();
    assert.equal(left.length, 11);
    assert.ok(left.includes('other.log'));
    assert.ok(!left.includes('pre-push-2026-01-10.log') && left.includes('pre-push-2026-01-12.log'));
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});

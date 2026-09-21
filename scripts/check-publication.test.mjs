import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import test from 'node:test';
import { checkPublication, inspectPublication } from './check-publication.mjs';

test('rejects private values without echoing them in diagnostics', () => {
  const secret = 'sk-' + 'x'.repeat(32);
  const localPath = ['Z:', 'Users', 'synthetic-user', 'work'].join('\\');
  const credentialUrl = ['https://', 'user:password', '@example.invalid'].join('');
  const text = `${secret}\n${localPath}\n${credentialUrl}`;
  const result = inspectPublication('report.json', Buffer.from(text));
  assert.deepEqual(result.findings.map(f => f.category), ['provider-token', 'machine-path', 'credential-url']);
  assert.ok(!JSON.stringify(result).includes(secret));
  assert.ok(!JSON.stringify(result).includes(localPath));
  assert.equal(inspectPublication('data.sqlite', Buffer.from([0, 1])).findings[0].category, 'private-file');
  assert.equal(inspectPublication('.env.local', Buffer.from('')).findings[0].category, 'private-file');
});

test('allows portable configuration and official API examples', () => {
  const text = 'https://example.invalid/v1/audio/transcriptions\n%DOCUMENTS%/MANGA\n${MANGA_PROFILE_DIR}\nAPI_KEY=\n';
  assert.deepEqual(inspectPublication('.env.example', Buffer.from(text)).findings, []);
  assert.deepEqual(inspectPublication('docs/example.md', Buffer.from(text)).findings, []);
});

test('checks untracked files and the index even after worktree cleanup', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'manga-publication-test-'));
  const git = args => execFileSync('git', args, { cwd: root, stdio: 'pipe' });
  try {
    git(['init', '-q']);
    fs.writeFileSync(path.join(root, 'report.txt'), 'ghp_' + 'x'.repeat(32));
    git(['add', 'report.txt']);
    fs.writeFileSync(path.join(root, 'report.txt'), 'redacted');
    fs.writeFileSync(path.join(root, 'new-report.txt'), ['/', 'home/', 'synthetic-user/', 'project'].join(''));
    fs.writeFileSync(path.join(root, '.gitignore'), '.env\n');
    fs.writeFileSync(path.join(root, '.env'), 'sk-' + 'x'.repeat(32));
    const result = checkPublication(root);
    assert.ok(result.findings.some(f => f.file === 'report.txt' && f.source === 'index'));
    assert.ok(result.findings.some(f => f.file === 'new-report.txt' && f.source === 'worktree'));
    assert.ok(!result.findings.some(f => f.file === '.env'));
    assert.ok(!result.findings.some(f => f.file === 'report.txt' && f.source === 'worktree'));
  } finally {
    // Only remove the directory created by this test, using the same filesystem API.
    assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(root).startsWith('manga-publication-test-'));
    fs.rmSync(root, { recursive: true, force: true });
  }
});

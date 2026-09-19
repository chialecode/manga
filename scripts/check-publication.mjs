import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// Diagnostics contain locations and categories only, never matched private values.
const rules = [
  ['machine-path', /(?<![\w])(?:[a-z]:[\\/][^\s"'<>`]+|\/(?:Users|home|tmp|private\/var)\/[^\s"'<>`]+)/i],
  ['private-key', /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/],
  ['provider-token', /\b(?:sk-(?:proj-)?[A-Za-z0-9_-]{20,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/],
  ['credential-url', /https?:\/\/[^\s/@:]+:[^\s/@]+@/i],
  ['credential-value', /["']?(?:api[_-]?key|access[_-]?token|client[_-]?secret)["']?\s*[:=]\s*["'][A-Za-z0-9_+\/-]{20,}["']/i],
];

export function inspectPublication(file, bytes) {
  const findings = [];
  const normalized = file.replaceAll('\\', '/');
  if (/(?:^|\/)(?:\.env(?:\.[^/]+)?|[^/]+\.(?:pem|key|p12|pfx|sqlite(?:-[^/]+)?|db(?:-[^/]+)?))$/i.test(normalized)
      && !/(?:^|\/)\.env(?:\.[^/]+)?\.example$/i.test(normalized)) {
    findings.push({ file, line: 0, category: 'private-file' });
  }
  const binary = bytes.includes(0);
  if (!binary) {
    for (const [index, line] of bytes.toString('utf8').split(/\r?\n/).entries()) {
      for (const [category, pattern] of rules) {
        if (pattern.test(line)) findings.push({ file, line: index + 1, category });
      }
    }
  }
  return { findings, binary };
}

export function checkPublication(root) {
  const git = args => execFileSync('git', args, { cwd: root, maxBuffer: 64 * 1024 * 1024 });
  const names = git(['ls-files', '--cached', '--others', '--exclude-standard', '-z'])
    .toString('utf8').split('\0').filter(Boolean);
  const staged = new Set(git(['ls-files', '--cached', '-z']).toString('utf8').split('\0').filter(Boolean));
  const findings = [];
  let binarySnapshots = 0;
  let snapshots = 0;
  for (const file of [...new Set(names)]) {
    const inspect = (bytes, source) => {
      const result = inspectPublication(file, bytes);
      snapshots++;
      binarySnapshots += Number(result.binary);
      findings.push(...result.findings.map(finding => ({ ...finding, source })));
    };
    const absolute = path.join(root, file);
    if (fs.existsSync(absolute) && fs.lstatSync(absolute).isFile()) {
      inspect(fs.readFileSync(absolute), 'worktree');
    }
    // A cleaned working copy must not hide a private value still staged for commit.
    if (staged.has(file)) inspect(git(['show', `:${file}`]), 'index');
  }
  return { files: new Set(names).size, snapshots, binarySnapshots, findings };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const result = checkPublication(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'));
    for (const finding of result.findings) console.error(JSON.stringify(finding));
    console.log(JSON.stringify({ check: 'publication', status: result.findings.length ? 'failed' : 'passed',
      files: result.files, snapshots: result.snapshots, binarySnapshots: result.binarySnapshots }));
    process.exitCode = result.findings.length ? 1 : 0;
  } catch {
    console.error('Publication check could not read all candidate files or index entries.');
    process.exitCode = 1;
  }
}

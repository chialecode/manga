import { chmod, stat } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'

const gitCheck = spawnSync('git', ['rev-parse', '--git-dir'], {
  encoding: 'utf8',
})

if (gitCheck.status !== 0) {
  process.stdout.write('Git metadata unavailable; hook installation skipped.\n')
  process.exit(0)
}

const configure = spawnSync('git', ['config', 'core.hooksPath', '.githooks'], {
  encoding: 'utf8',
})

if (configure.status !== 0) {
  process.stderr.write(configure.stderr)
  process.exit(configure.status ?? 1)
}

for (const hook of ['.githooks/pre-commit', '.githooks/pre-push']) {
  await stat(hook)
  if (process.platform !== 'win32') await chmod(hook, 0o755)
}

process.stdout.write('Installed pre-commit and pre-push hooks via core.hooksPath.\n')

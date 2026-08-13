import { readdir, readFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { pathToFileURL } from 'node:url'

const NAME = /^(\d{4})_[a-z0-9-]+\.sql$/u

export async function migrationValidationViolations(directory) {
  const files = (await readdir(directory)).filter((file) => file.endsWith('.sql')).sort()
  const violations = []
  const seen = new Set()
  for (const [index, file] of files.entries()) {
    const match = NAME.exec(basename(file))
    if (!match) { violations.push(`${file}: invalid migration name`); continue }
    const version = Number(match[1])
    if (seen.has(version)) violations.push(`${file}: duplicate migration number`)
    seen.add(version)
    if (version !== index + 1) violations.push(`${file}: migration numbers must be continuous`)
    if (!/rollback\s*:/iu.test(await readFile(join(directory, file), 'utf8'))) violations.push(`${file}: rollback explanation is required`)
  }
  return violations
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const violations = await migrationValidationViolations(process.argv[2] ?? 'packages/data/migrations')
  if (violations.length > 0) { process.stderr.write(`${violations.join('\n')}\n`); process.exitCode = 1 }
}

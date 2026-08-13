import { createHash } from 'node:crypto'
import { readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'

export async function migrationFreezeViolations(directory, lockPath) {
  const lock = JSON.parse(await readFile(lockPath, 'utf8'))
  const violations = []
  for (const file of (await readdir(directory)).filter((name) => name.endsWith('.sql'))) {
    const actual = createHash('sha256').update(await readFile(join(directory, file))).digest('hex')
    if (lock[file] !== actual) violations.push(`${file}: frozen migration hash changed`)
  }
  return violations
}

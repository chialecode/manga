import { readFile } from 'node:fs/promises'
import { sourceFiles } from './source-files.mjs'

export async function forbiddenSourcePattern(root, pattern) {
  const violations = []
  for (const file of await sourceFiles(root)) {
    if (pattern.test(await readFile(file, 'utf8'))) violations.push(file)
  }
  return violations
}

import { readFile } from 'node:fs/promises'
import { relative, sep } from 'node:path'
import { sourceFiles } from './source-files.mjs'

const FORBIDDEN = [
  'MANGA Dev', 'MANGA', 'app.manga.desktop.dev', 'app.manga.desktop',
  'manga-dev://', 'manga://', "'manga-dev'", "'manga'", "'media'", "'book'",
]

export async function identityLiteralViolations(root) {
  const violations = []
  const files = await sourceFiles(root)
  files.push(`${root}/apps/desktop/forge.config.mjs`)
  for (const file of files) {
    const name = relative(root, file).split(sep).join('/')
    if (name === 'packages/contract/src/identity.ts' || name.includes('/__tests__/')) continue
    const source = await readFile(file, 'utf8')
    for (const literal of FORBIDDEN) if (source.includes(literal)) violations.push(`${name}: identity literal ${literal}`)
  }
  return violations
}

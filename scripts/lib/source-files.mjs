import { readdir } from 'node:fs/promises'
import { extname, join } from 'node:path'

const SOURCE_EXTENSIONS = new Set(['.ts', '.tsx', '.mts', '.cts'])

export async function sourceFiles(root) {
  const found = []
  async function visit(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name === 'out' || entry.name === 'dist') continue
      const path = join(directory, entry.name)
      if (entry.isDirectory()) await visit(path)
      else if (SOURCE_EXTENSIONS.has(extname(entry.name))) found.push(path)
    }
  }
  await visit(root)
  return found
}

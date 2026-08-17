import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createHash } from 'node:crypto'

type VendorFiles = Readonly<Record<string, string>>

export async function assertVendorFiles(directory: string, files: VendorFiles): Promise<void> {
  for (const [file, expected] of Object.entries(files)) {
    const actual = createHash('sha256').update(await readFile(join(directory, file))).digest('hex')
    if (actual !== expected) throw new Error('Vendor binary integrity check failed')
  }
}

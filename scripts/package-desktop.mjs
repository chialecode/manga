import { createHash } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'

const artifact = process.argv[2]
if (!artifact) throw new Error('Provide a packaged artifact path')
const hash = createHash('sha256').update(await readFile(artifact)).digest('hex')
await writeFile(`${artifact}.sha256`, `${hash}  ${artifact}\n`)
process.stdout.write(`${hash}\n`)

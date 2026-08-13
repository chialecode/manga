import { createHash } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'

const lock = await readFile('pnpm-lock.yaml', 'utf8')
const hash = createHash('sha256').update(lock).digest('hex')
const notice = `# Third-Party Notices\n\nGenerated from pnpm-lock.yaml.\n\nLockfile-SHA256: ${hash}\n`
const sbom = { spdxVersion: 'SPDX-2.3', dataLicense: 'CC0-1.0', lockfileSha256: hash }
await writeFile('THIRD-PARTY-NOTICES.md', notice)
await writeFile('sbom.spdx.json', `${JSON.stringify(sbom, null, 2)}\n`)

import { generateKeyPairSync } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

const destination = process.argv[2]
if (!destination) throw new Error('Provide an external destination directory')
const { privateKey, publicKey } = generateKeyPairSync('ed25519')
await mkdir(destination, { recursive: true })
await writeFile(join(destination, 'update-public.pem'), publicKey.export({ type: 'spki', format: 'pem' }))
await writeFile(join(destination, 'update-private.pem'), privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 })

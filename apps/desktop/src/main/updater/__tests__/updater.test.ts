import { createHash, generateKeyPairSync, sign } from 'node:crypto'
import { createServer } from 'node:http'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { isUpgrade, runUpdate, verifyUpdate } from '../index.js'

const temporaryDirectories: string[] = []
afterEach(async () => { await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))) })

it('accepts only a higher semantic version', () => {
  expect(isUpgrade('0.0.1', '0.0.2')).toBe(true)
  expect(isUpgrade('0.0.2', '0.0.1')).toBe(false)
  expect(isUpgrade('0.0.2', '0.0.2')).toBe(false)
})

it('rejects package tampering and validates Ed25519', () => {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519')
  const bytes = Buffer.from('package')
  const manifest = {
    version: '0.0.2',
    packageUrl: 'http://127.0.0.1/package',
    sha256: createHash('sha256').update(bytes).digest('hex'),
    signature: sign(null, bytes, privateKey).toString('base64'),
  }
  expect(() => {
    verifyUpdate('0.0.1', manifest, bytes, publicKey.export({ type: 'spki', format: 'pem' }).toString())
  }).not.toThrow()
  expect(() => {
    verifyUpdate('0.0.1', manifest, Buffer.from('tampered'), publicKey.export({ type: 'spki', format: 'pem' }).toString())
  }).toThrow(/sha256/)
})

it('falls back, resumes with Range, verifies, then launches the installer', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'updater-'))
  temporaryDirectories.push(directory)
  const destination = join(directory, 'package.exe')
  const bytes = Buffer.from('complete-update-package')
  await writeFile(destination, bytes.subarray(0, 8))
  const { privateKey, publicKey } = generateKeyPairSync('ed25519')
  let baseUrl = ''
  let rangeHeader: string | undefined
  const server = createServer((request, response) => {
    if (request.url === '/primary') { response.writeHead(503).end(); return }
    if (request.url === '/fallback') {
      response.end(JSON.stringify({
        version: '0.0.2', packageUrl: `${baseUrl}/package`,
        sha256: createHash('sha256').update(bytes).digest('hex'),
        signature: sign(null, bytes, privateKey).toString('base64'),
      }))
      return
    }
    rangeHeader = request.headers.range
    response.writeHead(206, { 'Content-Range': `bytes 8-${String(bytes.length - 1)}/${String(bytes.length)}` })
    response.end(bytes.subarray(8))
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Local update server did not bind')
  baseUrl = `http://127.0.0.1:${String(address.port)}`
  const launched: string[] = []
  try {
    await runUpdate({
      currentVersion: '0.0.1', sources: [new URL(`${baseUrl}/primary`), new URL(`${baseUrl}/fallback`)], destination,
      publicKey: publicKey.export({ type: 'spki', format: 'pem' }).toString(),
      launchInstaller: (path) => { launched.push(path); return Promise.resolve() },
    })
  } finally { await new Promise<void>((resolve, reject) => server.close((error) => { if (error) reject(error); else resolve() })) }
  expect(rangeHeader).toBe('bytes=8-')
  expect(await readFile(destination)).toEqual(bytes)
  expect(launched).toEqual([destination])
})

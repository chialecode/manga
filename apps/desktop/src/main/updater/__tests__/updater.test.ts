import { createHash, generateKeyPairSync, sign } from 'node:crypto'
import { expect, it } from 'vitest'
import { isUpgrade, verifyUpdate } from '../index.js'

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

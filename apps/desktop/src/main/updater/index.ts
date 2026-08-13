import { createHash, verify } from 'node:crypto'

export type UpdateManifest = Readonly<{
  version: string
  sha256: string
  signature: string
}>

function parts(version: string): readonly [number, number, number] {
  const match = /^(\d+)\.(\d+)\.(\d+)$/u.exec(version)
  if (!match) throw new Error('Invalid semantic version')
  return [Number(match[1]), Number(match[2]), Number(match[3])]
}

export function isUpgrade(current: string, candidate: string): boolean {
  const left = parts(current)
  const right = parts(candidate)
  for (let index = 0; index < left.length; index += 1) {
    if (right[index] !== left[index]) return (right[index] ?? 0) > (left[index] ?? 0)
  }
  return false
}

export function verifyUpdate(currentVersion: string, manifest: UpdateManifest, bytes: Uint8Array, publicKey: string): void {
  if (!isUpgrade(currentVersion, manifest.version)) throw new Error('Update downgrade or reinstall rejected')
  const actual = createHash('sha256').update(bytes).digest('hex')
  if (actual !== manifest.sha256) throw new Error('Update sha256 mismatch')
  if (!verify(null, bytes, publicKey, Buffer.from(manifest.signature, 'base64'))) throw new Error('Update signature invalid')
}

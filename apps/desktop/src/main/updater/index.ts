import { createHash, verify } from 'node:crypto'
import { z } from 'zod'
import { downloadResumable, fetchJson, readFile } from './transport.js'

export type UpdateManifest = Readonly<{
  version: string
  packageUrl: string
  sha256: string
  signature: string
}>

const updateManifestSchema = z.object({
  version: z.string().regex(/^\d+\.\d+\.\d+$/u),
  packageUrl: z.url(),
  sha256: z.string().regex(/^[a-f0-9]{64}$/u),
  signature: z.string().min(1),
})

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

export type UpdateRunOptions = Readonly<{
  currentVersion: string
  sources: readonly URL[]
  destination: string
  publicKey: string
  launchInstaller: (path: string) => Promise<void>
  signal?: AbortSignal
}>

export async function runUpdate(options: UpdateRunOptions): Promise<UpdateManifest> {
  let lastError: unknown
  for (const source of options.sources) {
    try {
      const manifest = updateManifestSchema.parse(await fetchJson(source, options.signal))
      if (!isUpgrade(options.currentVersion, manifest.version)) throw new Error('Update downgrade or reinstall rejected')
      await downloadResumable(new URL(manifest.packageUrl), options.destination, options.signal)
      const bytes = await readFile(options.destination)
      verifyUpdate(options.currentVersion, manifest, bytes, options.publicKey)
      await options.launchInstaller(options.destination)
      return manifest
    } catch (error: unknown) {
      lastError = error
    }
  }
  throw lastError instanceof Error ? lastError : new Error('All update sources failed')
}

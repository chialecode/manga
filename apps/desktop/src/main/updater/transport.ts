import { createWriteStream } from 'node:fs'
import { readFile, stat } from 'node:fs/promises'
import { pipeline } from 'node:stream/promises'

const MAX_MANIFEST_BYTES = 1024 * 1024

export { readFile }

export async function fetchJson(url: URL, signal?: AbortSignal): Promise<unknown> {
  const response = await fetch(url, { ...(signal ? { signal } : {}), redirect: 'error' })
  if (!response.ok || !response.body) throw new Error(`Update manifest request failed with ${String(response.status)}`)
  const length = Number(response.headers.get('content-length') ?? '0')
  if (length > MAX_MANIFEST_BYTES) throw new Error('Update manifest exceeds size limit')
  const text = await response.text()
  if (Buffer.byteLength(text) > MAX_MANIFEST_BYTES) throw new Error('Update manifest exceeds size limit')
  return JSON.parse(text)
}

export async function downloadResumable(url: URL, destination: string, signal?: AbortSignal): Promise<void> {
  let existing = 0
  try { existing = (await stat(destination)).size } catch { /* A missing staging file starts at byte zero. */ }
  const headers = existing > 0 ? { Range: `bytes=${String(existing)}-` } : undefined
  const response = await fetch(url, { ...(signal ? { signal } : {}), ...(headers ? { headers } : {}), redirect: 'error' })
  if (!response.ok || !response.body) throw new Error(`Update download failed with ${String(response.status)}`)
  if (existing > 0 && response.status !== 206) throw new Error('Update source did not honor resume range')
  await pipeline(response.body, createWriteStream(destination, { flags: existing > 0 ? 'a' : 'wx' }))
}

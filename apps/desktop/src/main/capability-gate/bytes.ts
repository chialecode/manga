import { createReadStream } from 'node:fs'
import { stat, writeFile } from 'node:fs/promises'
import { Readable } from 'node:stream'

export async function fileSize(path: string): Promise<number> {
  return (await stat(path)).size
}

export function fileByteStream(path: string, start?: number, end?: number): ReadableStream<Uint8Array> {
  const source = createReadStream(path, { start, end })
  // createReadStream emits Buffer chunks, but Node's toWeb generic cannot infer that subtype.
  return Readable.toWeb(source) as ReadableStream<Uint8Array>
}

export async function writeBenchmarkMarker(path: string, visibleAtMs: number): Promise<void> {
  await writeFile(path, String(visibleAtMs), { flag: 'wx' })
}

import { createHash } from 'node:crypto'
import { fileByteStream, fileSize } from '../capability-gate/bytes.js'

export async function mediaResponse(path: string, rangeHeader: string | null, fingerprint: string): Promise<Response> {
  const size = await fileSize(path)
  const etag = `"${createHash('sha256').update(fingerprint).digest('hex')}"`
  try {
    const { parseRange } = await import('./range.js')
    const range = parseRange(rangeHeader, size)
    if (!range) {
      return new Response(fileByteStream(path), {
        headers: { 'Accept-Ranges': 'bytes', 'Content-Length': String(size), ETag: etag },
      })
    }
    return new Response(fileByteStream(path, range.start, range.end), {
      status: 206,
      headers: {
        'Accept-Ranges': 'bytes',
        'Content-Length': String(range.end - range.start + 1),
        'Content-Range': `bytes ${String(range.start)}-${String(range.end)}/${String(size)}`,
        ETag: etag,
      },
    })
  } catch {
    return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${String(size)}` } })
  }
}

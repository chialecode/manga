import { fileByteStream, fileSize } from '../capability-gate/bytes.js'
import { BOOK_CSP } from '../security/csp.js'

export async function bookResponse(path: string): Promise<Response> {
  const size = await fileSize(path)
  return new Response(fileByteStream(path), {
    headers: {
      'Content-Length': String(size),
      'Content-Security-Policy': BOOK_CSP,
    },
  })
}

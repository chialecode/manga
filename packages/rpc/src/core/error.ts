import { randomUUID } from 'node:crypto'
import type { WireError } from '@manga/contract'

export function toWireError(error: unknown, traceId: string = randomUUID()): WireError {
  const message = error instanceof Error && error.name === 'AbortError' ? 'Operation cancelled' : 'Operation failed'
  return {
    code: error instanceof Error && error.name === 'AbortError' ? 'cancelled' : 'internal',
    message,
    retryable: false,
    traceId,
  }
}

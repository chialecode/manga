import type { WireError } from '@manga/contract'

export type Frame =
  | Readonly<{ t: 'chunk'; seq: number; data: unknown }>
  | Readonly<{ t: 'end'; result: unknown }>
  | Readonly<{ t: 'error'; error: WireError }>
  | Readonly<{ t: 'credit'; n: number }>

export function encodeFrame(frame: Frame): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(frame))
}

export function decodeFrame(bytes: Uint8Array): Frame {
  const parsed: unknown = JSON.parse(new TextDecoder().decode(bytes))
  if (!parsed || typeof parsed !== 'object' || !('t' in parsed)) throw new Error('Invalid RPC frame')
  const tag = Reflect.get(parsed, 't')
  if (!['chunk', 'end', 'error', 'credit'].includes(String(tag))) throw new Error('Invalid RPC frame tag')
  // The router applies method-specific zod validation to payload fields.
  return parsed as Frame
}

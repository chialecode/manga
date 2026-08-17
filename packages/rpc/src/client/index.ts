export { QueryCache } from './cache.js'

import type { MethodDefinition } from '@manga/contract'
import { CREDIT_POLICY } from '../core/credit.js'

type RpcBridge = Readonly<{
  invoke(method: string, input: unknown, callId: string): Promise<unknown>
  stream(method: string, input: unknown, callId: string, port: MessagePort): void
  cancel(callId: string): void
}>

declare global {
  interface Window { __rpc?: RpcBridge }
}

function bridge(): RpcBridge {
  const value = typeof window !== 'undefined' ? window.__rpc : undefined
  if (!value) throw new Error('RPC bridge unavailable')
  return value
}

export async function invoke<I, O>(definition: MethodDefinition<I, O>, input: I): Promise<O> {
  const callId = crypto.randomUUID()
  const response = await bridge().invoke(definition.name, definition.input.parse(input), callId) as { ok: boolean; value?: unknown; error?: unknown }
  if (!response.ok) throw response.error
  return definition.output.parse(response.value)
}

export function cancel(callId: string): void {
  bridge().cancel(callId)
}

export function stream<I, O, S>(definition: MethodDefinition<I, O, S>, input: I): { callId: string; port: MessagePort; cancel(): void } {
  if (!definition.stream) throw new Error(`Method ${definition.name} is not streaming`)
  const callId = crypto.randomUUID()
  const channel = new MessageChannel()
  window.postMessage({ t: 'rpc:port', callId }, '*', [channel.port2])
  bridge().stream(definition.name, definition.input.parse(input), callId, channel.port2)
  let consumed = 0
  channel.port1.addEventListener('message', (event: MessageEvent<unknown>) => {
    const frame = event.data
    if (!frame || typeof frame !== 'object' || Reflect.get(frame, 't') !== 'chunk') return
    consumed += 1
    if (consumed < CREDIT_POLICY.replenishAt) return
    consumed = 0
    channel.port1.postMessage({ t: 'credit', n: CREDIT_POLICY.replenishAt })
  })
  channel.port1.start()
  return { callId, port: channel.port1, cancel: () => { bridge().cancel(callId) } }
}

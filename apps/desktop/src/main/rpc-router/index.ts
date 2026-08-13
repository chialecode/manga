import { randomUUID } from 'node:crypto'
import type { MethodDefinition } from '@manga/contract'
import { toWireError } from '@manga/rpc'
import type { WireError } from '@manga/contract'

type Handler = (input: unknown, signal: AbortSignal) => Promise<unknown>
type Route = Readonly<{
  method: Readonly<Pick<MethodDefinition<unknown, unknown>, 'input' | 'output'>>
  handler: Handler
}>

export class RpcWireError extends Error {
  constructor(readonly wire: WireError) {
    super(wire.message)
    this.name = 'RpcWireError'
  }
}

export class RpcRouter {
  readonly #routes = new Map<string, Route>()

  register<I, O>(method: MethodDefinition<I, O>, handler: (input: I, signal: AbortSignal) => O | Promise<O>): void {
    if (this.#routes.has(method.name)) throw new Error('Duplicate RPC method')
    this.#routes.set(method.name, {
      method,
      handler: async (rawInput, signal) => handler(method.input.parse(rawInput), signal),
    })
  }

  async invoke(name: string, rawInput: unknown, signal: AbortSignal): Promise<unknown> {
    const route = this.#routes.get(name)
    if (!route) throw new RpcWireError(toWireError(new Error('Unknown method'), randomUUID()))
    try {
      const input = route.method.input.parse(rawInput)
      const output = await route.handler(input, signal)
      return route.method.output.parse(output)
    } catch (error: unknown) {
      throw new RpcWireError(toWireError(error, randomUUID()))
    }
  }
}

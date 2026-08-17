import type { ZodType } from 'zod'

export type MethodDefinition<I, O, S = never> = Readonly<{
  name: `${string}.${string}`
  input: ZodType<I>
  output: ZodType<O>
  stream?: ZodType<S>
  invalidates?: readonly string[]
}>

export function method<I, O, S = never>(definition: MethodDefinition<I, O, S>): MethodDefinition<I, O, S> {
  return Object.freeze(definition)
}

import { z } from 'zod'
import { method } from './method.js'

export const sysEcho = method({
  name: 'sys.echo',
  input: z.object({ value: z.string().max(4096) }),
  output: z.object({ value: z.string() }),
})

export const sysTicker = method({
  name: 'sys.ticker',
  input: z.object({ intervalMs: z.number().int().min(1).max(1000) }),
  stream: z.object({ tick: z.number().int().nonnegative() }),
  output: z.object({ ticks: z.number().int().nonnegative() }),
})

export const SYSTEM_METHODS = [sysEcho, sysTicker] as const

import { describe, expect, it } from 'vitest'
import { CancellationRegistry } from '../core/cancel.js'
import { CREDIT_POLICY, CreditWindow } from '../core/credit.js'
import { toWireError } from '../core/error.js'

describe('RPC cancellation', () => {
  it('aborts active work within 200 ms', async () => {
    const registry = new CancellationRegistry()
    const signal = registry.begin('call-1')
    const startedAtMs = Date.now()
    const stopped = new Promise<number>((resolve) => {
      signal.addEventListener(
        'abort',
        () => {
          resolve(Date.now() - startedAtMs)
        },
        { once: true },
      )
    })
    registry.cancel('call-1')
    await expect(stopped).resolves.toBeLessThan(200)
    expect(registry.size).toBe(0)
  })
})

describe('RPC backpressure', () => {
  it('bounds an unconsumed producer to the initial credit', async () => {
    const credit = new CreditWindow()
    let produced = 0
    const controller = new AbortController()
    const producer = (async (): Promise<void> => {
      try {
        for (;;) {
          await credit.acquire(controller.signal)
          produced += 1
        }
      } catch (error: unknown) {
        if (!controller.signal.aborted) throw error
      }
    })()
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(produced).toBe(CREDIT_POLICY.initial)
    controller.abort()
    await producer
  })
})

it('redacts host exception details from WireError', () => {
  const wire = toWireError(new Error('C:\\Users\\x\\secret.epub not found'), 'trace-1')
  expect(JSON.stringify(wire)).not.toContain('secret.epub')
  expect(wire.traceId).toBe('trace-1')
})

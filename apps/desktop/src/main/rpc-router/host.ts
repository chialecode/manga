import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { app, ipcMain } from 'electron'
import { sysEcho, sysTicker } from '@manga/contract'
import { CancellationRegistry, CreditWindow, toWireError } from '@manga/rpc'
import type { Frame } from '@manga/rpc'
import { writeLog } from '../logger/index.js'
import { RpcRouter, RpcWireError } from './index.js'

type InvokeRequest = Readonly<{ method: unknown; input: unknown; callId: unknown }>
function isRequest(value: unknown): value is InvokeRequest {
  return Boolean(value && typeof value === 'object' && 'method' in value && 'input' in value && 'callId' in value)
}

async function logHostError(traceId: string, method: string, error: unknown): Promise<void> {
  await writeLog(join(app.getPath('logs'), 'rpc.jsonl'), {
    level: 'error',
    traceId,
    method,
    error: error instanceof Error ? { name: error.name, message: error.message, stack: error.stack } : error,
  })
}

function abortableDelay(intervalMs: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, intervalMs)
    signal.addEventListener('abort', () => {
      clearTimeout(timer)
      const error = new Error('Cancelled')
      error.name = 'AbortError'
      reject(error)
    }, { once: true })
  })
}

export function installRpcHost(options: Readonly<{ onStreamStopped?: (callId: string, cancellationMs: number) => void }> = {}): void {
  const calls = new CancellationRegistry()
  const cancelledAtMs = new Map<string, number>()
  const router = new RpcRouter()
  router.register(sysEcho, (input) => input)
  router.register(sysTicker, () => ({ ticks: 0 }))

  ipcMain.handle('rpc:invoke', async (_event, raw: unknown) => {
    if (!isRequest(raw) || typeof raw.method !== 'string' || typeof raw.callId !== 'string') {
      return { ok: false, error: toWireError(new Error('Invalid RPC envelope')) }
    }
    const callId = raw.callId
    const signal = calls.begin(callId)
    try {
      return { ok: true, value: await router.invoke(raw.method, raw.input, signal) }
    } catch (error: unknown) {
      const wire = error instanceof RpcWireError ? error.wire : toWireError(error)
      await logHostError(wire.traceId, raw.method, error)
      return { ok: false, error: wire }
    } finally {
      calls.finish(callId)
    }
  })

  ipcMain.on('rpc:cancel', (_event, callId: unknown) => {
    if (typeof callId === 'string') {
      cancelledAtMs.set(callId, Date.now())
      calls.cancel(callId)
    }
  })

  ipcMain.on('rpc:stream', (event, raw: unknown) => {
    const port = event.ports[0]
    if (!port || !isRequest(raw) || raw.method !== sysTicker.name || typeof raw.callId !== 'string') {
      port?.close()
      return
    }
    let input: { intervalMs: number }
    try {
      input = sysTicker.input.parse(raw.input)
    } catch (error: unknown) {
      port.postMessage({ t: 'error', error: toWireError(error) } satisfies Frame)
      port.close()
      return
    }
    const callId = raw.callId
    const signal = calls.begin(callId)
    const credit = new CreditWindow()
    port.on('message', (messageEvent: unknown) => {
      const data: unknown = messageEvent && typeof messageEvent === 'object' ? Reflect.get(messageEvent, 'data') : undefined
      if (data && typeof data === 'object' && Reflect.get(data, 't') === 'credit') {
        // Reflect.get is typed as any even though this untrusted IPC value must remain unknown.
        const count = Reflect.get(data, 'n') as unknown
        if (typeof count === 'number') credit.grant(count)
      }
    })
    port.start()
    void (async () => {
      let tick = 0
      try {
        while (!signal.aborted) {
          await credit.acquire(signal)
          await abortableDelay(input.intervalMs, signal)
          port.postMessage({ t: 'chunk', seq: tick, data: sysTicker.stream?.parse({ tick }) } satisfies Frame)
          tick += 1
        }
      } catch (error: unknown) {
        if (!signal.aborted) {
          const wire = toWireError(error, randomUUID())
          await logHostError(wire.traceId, sysTicker.name, error)
          port.postMessage({ t: 'error', error: wire } satisfies Frame)
        }
      } finally {
        calls.finish(callId)
        const cancelledAt = cancelledAtMs.get(callId)
        options.onStreamStopped?.(callId, cancelledAt === undefined ? 0 : Math.max(0, Date.now() - cancelledAt))
        cancelledAtMs.delete(callId)
        if (!signal.aborted) port.postMessage({ t: 'end', result: sysTicker.output.parse({ ticks: tick }) } satisfies Frame)
        port.close()
      }
    })()
  })
}

import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { app } from 'electron'
import { configureIdentityBeforeReady } from '../main/bootstrap.js'
import { installRpcHost } from '../main/rpc-router/host.js'
import { createAppWindow } from '../main/window/create-window.js'

configureIdentityBeforeReady()

interface SmokeResult {
  readonly echo: unknown
  readonly cancellationMs: number
  readonly chunksAtCancel: number
  readonly chunksAfterWait: number
  readonly rssGrowthBytes: number
  readonly slowConsumerReceived: number
  readonly slowConsumerConsumed: number
  readonly traceId: string
  readonly logContainsTraceId: boolean
}

void app.whenReady().then(async () => {
  const cancellationLatency = new Map<string, number>()
  installRpcHost({ onStreamStopped: (callId, cancellationMs) => { cancellationLatency.set(callId, cancellationMs) } })
  const rendererUrl = pathToFileURL(join(process.cwd(), 'apps', 'desktop', 'src', 'renderer', 'index.html')).href
  const window = await createAppWindow({ show: false, loadUrl: rendererUrl })
  const echo: unknown = await window.webContents.executeJavaScript(`window.__rpc.invoke('sys.echo',{value:'ok'},crypto.randomUUID())`)
  const ticker = await window.webContents.executeJavaScript(`new Promise((resolve) => {
    const channel = new MessageChannel(); const callId = crypto.randomUUID(); let chunks = 0; let cancelledAt = 0;
    channel.port1.onmessage = (event) => { if (event.data.t === 'chunk') { chunks += 1; if (chunks === 3) { cancelledAt = Date.now(); window.__rpc.cancel(callId); setTimeout(() => resolve({ callId, cancelledAt, chunksAtCancel: 3, chunksAfterWait: chunks }), 200); } } };
    channel.port1.start(); window.postMessage({t:'rpc:port',callId},'*',[channel.port2]); window.__rpc.stream('sys.ticker',{intervalMs:5},callId,channel.port2);
  })`, true) as { callId: string; cancelledAt: number; chunksAtCancel: number; chunksAfterWait: number }
  const cancellationMs = cancellationLatency.get(ticker.callId)
  if (cancellationMs === undefined) throw new Error('Host did not report ticker shutdown')

  const beforeRss = process.memoryUsage().rss
  const slowConsumer = await window.webContents.executeJavaScript(`new Promise((resolve) => {
    const channel = new MessageChannel(); const callId = crypto.randomUUID(); let pending = 0; let received = 0; let consumed = 0; const queued = [];
    channel.port1.onmessage = (event) => { if (event.data?.t === 'chunk') { received += 1; queued.push(event.data); } };
    channel.port1.start(); window.postMessage({t:'rpc:port',callId},'*',[channel.port2]); window.__rpc.stream('sys.ticker',{intervalMs:1},callId,channel.port2);
    const consumer = setInterval(() => { if (!queued.shift()) return; consumed += 1; pending += 1; if (pending === 16) { pending = 0; channel.port1.postMessage({t:'credit',n:16}); } }, 500);
    setTimeout(() => { clearInterval(consumer); window.__rpc.cancel(callId); resolve({received, consumed}); }, 60000);
  })`, true) as { received: number; consumed: number }
  const rssGrowthBytes = Math.max(0, process.memoryUsage().rss - beforeRss)

  const errorResponse = await window.webContents.executeJavaScript(`window.__rpc.invoke('missing.method',{},crypto.randomUUID())`, true) as { error: { traceId: string } }
  await new Promise((resolve) => setTimeout(resolve, 50))
  const log = await readFile(join(app.getPath('logs'), 'rpc.jsonl'), 'utf8')
  const result: SmokeResult = {
    echo,
    cancellationMs,
    chunksAtCancel: ticker.chunksAtCancel,
    chunksAfterWait: ticker.chunksAfterWait,
    rssGrowthBytes,
    slowConsumerReceived: slowConsumer.received,
    slowConsumerConsumed: slowConsumer.consumed,
    traceId: errorResponse.error.traceId,
    logContainsTraceId: log.includes(errorResponse.error.traceId),
  }
  process.stdout.write(`RPC_SMOKE ${JSON.stringify(result)}\n`)
  app.quit()
}).catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`)
  app.exit(1)
})

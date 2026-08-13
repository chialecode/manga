import { contextBridge, ipcRenderer } from 'electron'

type StreamRequest = Readonly<{ method: string; input: unknown; callId: string }>
const streamRequests = new Map<string, StreamRequest>()
const streamPorts = new Map<string, MessagePort>()

function dispatchStream(callId: string): void {
  const request = streamRequests.get(callId)
  const port = streamPorts.get(callId)
  if (!request || !port) return
  streamRequests.delete(callId)
  streamPorts.delete(callId)
  ipcRenderer.postMessage('rpc:stream', request, [port])
}

window.addEventListener('message', (event: MessageEvent<unknown>) => {
  if (event.source !== window || !event.data || typeof event.data !== 'object' || Reflect.get(event.data, 't') !== 'rpc:port') return
  const callId: unknown = Reflect.get(event.data, 'callId')
  const port = event.ports[0]
  if (typeof callId !== 'string' || !port) return
  streamPorts.set(callId, port)
  dispatchStream(callId)
})

const bridge = Object.freeze({
  invoke: (method: string, input: unknown, callId: string): Promise<unknown> =>
    ipcRenderer.invoke('rpc:invoke', { method, input, callId }),
  stream: (method: string, input: unknown, callId: string, _port: MessagePort): void => {
    void _port
    streamRequests.set(callId, { method, input, callId })
    dispatchStream(callId)
  },
  cancel: (callId: string): void => {
    ipcRenderer.send('rpc:cancel', callId)
  },
})

contextBridge.exposeInMainWorld('__rpc', bridge)

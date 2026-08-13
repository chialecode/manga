import { contextBridge, ipcRenderer } from 'electron'

const bridge = Object.freeze({
  invoke: (method: string, input: unknown): Promise<unknown> => ipcRenderer.invoke(method, input),
  stream: (method: string, input: unknown): void => {
    ipcRenderer.send('rpc:stream', method, input)
  },
  cancel: (callId: string): void => {
    ipcRenderer.send('rpc:cancel', callId)
  },
})

contextBridge.exposeInMainWorld('rpc', bridge)

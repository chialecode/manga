import { ipcRenderer } from 'electron'

export const electronTransport = Object.freeze({
  invoke: (method: string, input: unknown): Promise<unknown> => ipcRenderer.invoke(method, input),
  cancel: (callId: string): void => {
    ipcRenderer.send('rpc:cancel', callId)
  },
})

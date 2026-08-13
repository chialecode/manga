import { shell, type WebContents } from 'electron'

export function secureNavigation(webContents: WebContents): void {
  webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  webContents.on('will-navigate', (event) => {
    event.preventDefault()
  })
}

export async function openExternalHttps(rawUrl: string): Promise<void> {
  const url = new URL(rawUrl)
  if (url.protocol !== 'https:') throw new Error('External URL protocol is not allowed')
  await shell.openExternal(url.href)
}

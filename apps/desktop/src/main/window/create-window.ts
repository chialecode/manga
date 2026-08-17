import { join } from 'node:path'
import { app, BrowserWindow, session } from 'electron'
import { APP_CSP } from '../security/csp.js'
import { writeBenchmarkMarker } from '../benchmark/startup-marker.js'
import { secureNavigation } from '../security/navigation.js'
import { SECURE_WEB_PREFERENCES } from './web-preferences.js'

export async function createAppWindow(options: Readonly<{ show?: boolean; loadUrl?: string }> = {}): Promise<BrowserWindow> {
  const shouldShow = options.show !== false
  const window = new BrowserWindow({
    show: false,
    width: 960,
    height: 640,
    webPreferences: {
      ...SECURE_WEB_PREFERENCES,
      preload: join(__dirname, 'preload.js'),
    },
  })
  secureNavigation(window.webContents)
  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        'Content-Security-Policy': [APP_CSP],
      },
    })
  })
  window.once('ready-to-show', () => {
    if (shouldShow) window.show()
    const marker = __STARTUP_BENCHMARK__ ? process.env.APP_STARTUP_MARKER : undefined
    if (marker) {
      void writeBenchmarkMarker(marker, Date.now()).then(() => {
        app.quit()
      })
    }
  })
  if (options.loadUrl) {
    await window.loadURL(options.loadUrl)
  } else if (MAIN_WINDOW_VITE_DEV_SERVER_URL) {
    await window.loadURL(MAIN_WINDOW_VITE_DEV_SERVER_URL)
  } else {
    await window.loadFile(join(process.resourcesPath, 'renderer', MAIN_WINDOW_VITE_NAME, 'index.html'))
  }
  return window
}

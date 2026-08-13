import { join } from 'node:path'
import { app, BrowserWindow, session } from 'electron'
import { APP_CSP } from '../security/csp.js'
import { writeBenchmarkMarker } from '../capability-gate/bytes.js'
import { secureNavigation } from '../security/navigation.js'
import { SECURE_WEB_PREFERENCES } from './web-preferences.js'

export async function createAppWindow(): Promise<BrowserWindow> {
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
    window.show()
    const marker = process.env.APP_STARTUP_MARKER
    if (marker) {
      void writeBenchmarkMarker(marker, Date.now()).then(() => {
        app.quit()
      })
    }
  })
  if (MAIN_WINDOW_VITE_DEV_SERVER_URL) {
    await window.loadURL(MAIN_WINDOW_VITE_DEV_SERVER_URL)
  } else {
    const emptyDocument = `<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="${APP_CSP}"></head><body></body></html>`
    await window.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(emptyDocument)}`)
  }
  return window
}

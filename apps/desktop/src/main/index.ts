import { app } from 'electron'
import { DEEP_LINK_SCHEME } from '@manga/contract'
import { configureIdentityBeforeReady } from './bootstrap.js'
import './protocol/register.js'
import { createAppWindow } from './window/create-window.js'

configureIdentityBeforeReady()
if (!process.env.APP_STARTUP_MARKER) app.setAsDefaultProtocolClient(DEEP_LINK_SCHEME)

const ownsInstance = app.requestSingleInstanceLock()
if (!ownsInstance) app.quit()
else {
  app.on('window-all-closed', () => {
    app.quit()
  })
  void app.whenReady().then(createAppWindow).catch(() => {
    app.exit(1)
  })
}

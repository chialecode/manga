import { app } from 'electron'
import { join } from 'node:path'
import { DEEP_LINK_SCHEME } from '@manga/contract'
import { configureIdentityBeforeReady, startDatabaseService, stopDatabaseService } from './bootstrap.js'
import './protocol/register.js'
import { createAppWindow } from './window/create-window.js'
import { installRpcHost } from './rpc-router/host.js'
import { installCapabilityProtocols } from './protocol/register.js'

configureIdentityBeforeReady()
if (!__STARTUP_BENCHMARK__) app.setAsDefaultProtocolClient(DEEP_LINK_SCHEME)

const ownsInstance = app.requestSingleInstanceLock()
if (!ownsInstance) app.quit()
else {
  app.on('window-all-closed', () => {
    stopDatabaseService()
    app.quit()
  })
  void app.whenReady().then(async () => {
    installRpcHost()
    startDatabaseService()
    await installCapabilityProtocols(app.getPath('sessionData'), join(app.getPath('userData'), 'roots.json'))
    return await createAppWindow()
  }).catch((error: unknown) => {
    process.stderr.write(`main startup failed: ${error instanceof Error ? error.stack ?? error.message : String(error)}\n`)
    app.exit(1)
  })
}

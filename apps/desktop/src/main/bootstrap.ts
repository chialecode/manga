import { dirname, join } from 'node:path'
import { app } from 'electron'
import { APP_DIR_NAME, APP_ID } from '@manga/contract'

export function configureIdentityBeforeReady(): void {
  const benchmarkMarker = process.env.APP_STARTUP_MARKER
  const benchmarkRoot = benchmarkMarker ? join(dirname(benchmarkMarker), 'profile') : undefined
  const roamingRoot = benchmarkRoot ?? join(app.getPath('appData'), APP_DIR_NAME)
  const localAppData = process.env.LOCALAPPDATA
  if (!benchmarkRoot && !localAppData) throw new Error('LOCALAPPDATA is required')
  const localRoot = benchmarkRoot ?? join(localAppData ?? '', APP_DIR_NAME)
  app.setName(APP_DIR_NAME)
  app.setAppUserModelId(APP_ID)
  app.setPath('userData', roamingRoot)
  app.setPath('sessionData', localRoot)
  app.setPath('logs', join(localRoot, 'logs'))
  app.setPath('crashDumps', join(localRoot, 'crashes'))
}

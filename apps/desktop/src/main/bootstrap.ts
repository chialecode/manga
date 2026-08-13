import { dirname, join } from 'node:path'
import { app, utilityProcess } from 'electron'
import { APP_DIR_NAME, APP_ID } from '@manga/contract'
import { Supervisor } from './supervisor/index.js'

let databaseSupervisor: Supervisor | undefined

export function configureIdentityBeforeReady(): void {
  const benchmarkMarker = __STARTUP_BENCHMARK__ ? process.env.APP_STARTUP_MARKER : undefined
  const benchmarkRoot = benchmarkMarker ? join(dirname(benchmarkMarker), 'profile') : undefined
  const roamingBase = process.env.APPDATA ?? app.getPath('appData')
  const roamingRoot = benchmarkRoot ?? join(roamingBase, APP_DIR_NAME)
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

export function startDatabaseService(): void {
  if (__STARTUP_BENCHMARK__ || process.platform !== 'win32') return
  const entry = join(process.resourcesPath, 'svc-db.cjs')
  databaseSupervisor = new Supervisor()
  const env = {
    SystemRoot: process.env.SystemRoot ?? 'C:\\Windows',
    NODE_PATH: `${join(process.resourcesPath, 'node_modules')};${process.resourcesPath}`,
    SVC_DB_PATH: join(app.getPath('userData'), 'data.sqlite'),
    SVC_DB_MIGRATIONS: join(process.resourcesPath, 'migrations'),
    SVC_DB_BACKUPS: join(app.getPath('userData'), 'backups'),
  }
  void databaseSupervisor.superviseUtility(
    () => {
      const child = utilityProcess.fork(entry, [], { env, serviceName: 'svc-db', stdio: 'pipe' })
      child.on('message', (message: unknown) => {
        if (message && typeof message === 'object' && Reflect.get(message, 'type') === 'heartbeat') databaseSupervisor?.heartbeat()
      })
      child.stderr?.on('data', (chunk: Buffer) => { process.stderr.write(`svc-db: ${chunk.toString('utf8')}`) })
      child.on('exit', (code) => { process.stderr.write(`svc-db exited with code ${String(code)}\n`) })
      return child
    },
    { heartbeat: true },
  ).catch((error: unknown) => {
    process.stderr.write(`svc-db supervisor failed: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`)
  })
}

export function stopDatabaseService(): void {
  databaseSupervisor?.stop()
  databaseSupervisor = undefined
}

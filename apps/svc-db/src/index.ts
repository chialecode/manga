import { DatabaseService } from './connection.js'

export * from './connection.js'

type UtilityParentPort = Readonly<{
  on(event: 'message', listener: (event: unknown) => void): void
  postMessage(message: unknown): void
}>

function utilityParentPort(value: unknown): UtilityParentPort | undefined {
  if (!value || typeof value !== 'object') return undefined
  const on: unknown = Reflect.get(value, 'on')
  const postMessage: unknown = Reflect.get(value, 'postMessage')
  if (typeof on !== 'function' || typeof postMessage !== 'function') return undefined
  return {
    on: (event, listener) => { Reflect.apply(on, value, [event, listener]) },
    postMessage: (message) => { Reflect.apply(postMessage, value, [message]) },
  }
}

function isRequest(value: unknown): value is Parameters<DatabaseService['handle']>[0] {
  if (!value || typeof value !== 'object') return false
  const id: unknown = Reflect.get(value, 'id')
  const method: unknown = Reflect.get(value, 'method')
  return typeof id === 'string' && (method === 'system.integrityCheck' || method === 'libraryRoot.listEnabled')
}

const databasePath = process.env.SVC_DB_PATH
const migrationsDirectory = process.env.SVC_DB_MIGRATIONS
const backupDirectory = process.env.SVC_DB_BACKUPS

async function start(): Promise<void> {
  if (!databasePath || !migrationsDirectory || !backupDirectory) return
  const service = await DatabaseService.open(databasePath, migrationsDirectory, backupDirectory)
  const electronPort = utilityParentPort(Reflect.get(process, 'parentPort'))
  process.on('message', (message: unknown) => {
    if (isRequest(message)) process.send?.(service.handle(message))
  })
  if (electronPort) {
    electronPort.on('message', (event: unknown) => {
      const message: unknown = event && typeof event === 'object' ? Reflect.get(event, 'data') : undefined
      if (isRequest(message)) electronPort.postMessage(service.handle(message))
    })
  }
  process.once('disconnect', () => { service.close() })
  process.send?.({ type: 'ready' })
  if (electronPort) {
    electronPort.postMessage({ type: 'ready' })
    setInterval(() => { electronPort.postMessage({ type: 'heartbeat' }) }, 5000)
  }
}

void start().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`)
  process.exitCode = 1
})

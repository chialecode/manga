import { createLibraryRootRepository, migrate, openDatabase, recoverExpiredTasks } from '@manga/data'

type DatabaseConnection = ReturnType<typeof openDatabase>

export type DatabaseServiceRequest =
  | Readonly<{ id: string; method: 'system.integrityCheck' }>
  | Readonly<{ id: string; method: 'libraryRoot.listEnabled' }>

export type DatabaseServiceResponse = Readonly<{ id: string; ok: true; value: unknown }>

export class DatabaseService {
  readonly #db: DatabaseConnection

  private constructor(db: DatabaseConnection) {
    this.#db = db
  }

  static async open(databasePath: string, migrationsDirectory: string, backupDirectory: string): Promise<DatabaseService> {
    const db = openDatabase(databasePath)
    try {
      await migrate(db, migrationsDirectory, backupDirectory)
      recoverExpiredTasks(db, Date.now())
      return new DatabaseService(db)
    } catch (error: unknown) {
      db.close()
      throw error
    }
  }

  handle(request: DatabaseServiceRequest): DatabaseServiceResponse {
    if (request.method === 'system.integrityCheck') {
      return { id: request.id, ok: true, value: this.#db.pragma('integrity_check', { simple: true }) }
    }
    return { id: request.id, ok: true, value: createLibraryRootRepository(this.#db).listEnabled() }
  }

  close(): void {
    this.#db.close()
  }
}

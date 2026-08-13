import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

export type LibraryRoot = Readonly<{ id: string; path: string; enabled: boolean }>

export class RootRegistry {
  readonly #roots = new Map<string, LibraryRoot>()

  authorize(root: LibraryRoot): void {
    this.#roots.set(root.id, Object.freeze(root))
  }

  getEnabled(rootId: string): LibraryRoot | undefined {
    const root = this.#roots.get(rootId)
    return root?.enabled ? root : undefined
  }

  static async load(path: string): Promise<RootRegistry> {
    const registry = new RootRegistry()
    let raw: unknown
    try { raw = JSON.parse(await readFile(path, 'utf8')) } catch { return registry }
    if (!Array.isArray(raw)) return registry
    for (const item of raw) {
      if (!item || typeof item !== 'object') continue
      const id: unknown = Reflect.get(item, 'id')
      const rootPath: unknown = Reflect.get(item, 'path')
      const enabled: unknown = Reflect.get(item, 'enabled')
      if (typeof id === 'string' && typeof rootPath === 'string' && typeof enabled === 'boolean') registry.authorize({ id, path: rootPath, enabled })
    }
    return registry
  }

  async save(path: string): Promise<void> {
    await mkdir(dirname(path), { recursive: true })
    const temporary = `${path}.tmp`
    await writeFile(temporary, `${JSON.stringify([...this.#roots.values()], null, 2)}\n`, { flag: 'w' })
    await rename(temporary, path)
  }
}

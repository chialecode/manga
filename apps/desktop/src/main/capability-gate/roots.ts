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
}

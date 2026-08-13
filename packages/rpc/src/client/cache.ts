type Entry<T> = Readonly<{ value: Promise<T>; expiresAtMs: number; tags: readonly string[] }>

export class QueryCache {
  readonly #entries = new Map<string, Entry<unknown>>()

  getOrCreate<T>(key: string, ttlMs: number, tags: readonly string[], load: () => Promise<T>): Promise<T> {
    const current = this.#entries.get(key)
    if (current && current.expiresAtMs > Date.now()) return current.value as Promise<T>
    const value = load()
    this.#entries.set(key, { value, expiresAtMs: Date.now() + ttlMs, tags })
    void value.catch(() => this.#entries.delete(key))
    return value
  }

  invalidate(tag: string): void {
    for (const [key, entry] of this.#entries) if (entry.tags.includes(tag)) this.#entries.delete(key)
  }
}

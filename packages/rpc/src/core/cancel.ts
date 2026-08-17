export class CancellationRegistry {
  readonly #calls = new Map<string, AbortController>()

  begin(callId: string): AbortSignal {
    if (this.#calls.has(callId)) throw new Error('Duplicate call id')
    const controller = new AbortController()
    this.#calls.set(callId, controller)
    return controller.signal
  }

  cancel(callId: string): boolean {
    const controller = this.#calls.get(callId)
    if (!controller) return false
    controller.abort()
    this.#calls.delete(callId)
    return true
  }

  finish(callId: string): void {
    this.#calls.delete(callId)
  }

  get size(): number {
    return this.#calls.size
  }
}

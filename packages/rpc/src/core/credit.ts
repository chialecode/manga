const INITIAL_CREDIT = 32
const REPLENISH_AT = 16

type Waiter = () => void

export class CreditWindow {
  #available = INITIAL_CREDIT
  readonly #waiters: Waiter[] = []

  async acquire(signal?: AbortSignal): Promise<void> {
    if (this.#available > 0) {
      this.#available -= 1
      return
    }
    await new Promise<void>((resolve, reject) => {
      const onAbort = (): void => {
        reject(new Error('Cancelled'))
      }
      if (signal?.aborted) {
        onAbort()
        return
      }
      const waiter = (): void => {
        signal?.removeEventListener('abort', onAbort)
        this.#available -= 1
        resolve()
      }
      signal?.addEventListener('abort', onAbort, { once: true })
      this.#waiters.push(waiter)
    })
  }

  grant(count: number): void {
    if (!Number.isInteger(count) || count <= 0) throw new Error('Credit must be a positive integer')
    this.#available += count
    while (this.#available > 0 && this.#waiters.length > 0) this.#waiters.shift()?.()
  }

  get available(): number {
    return this.#available
  }
}

export const CREDIT_POLICY = Object.freeze({ initial: INITIAL_CREDIT, replenishAt: REPLENISH_AT })

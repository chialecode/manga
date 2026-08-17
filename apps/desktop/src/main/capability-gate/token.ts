import { randomBytes } from 'node:crypto'

const TOKEN_TTL_MS = 30 * 60 * 1000
type Grant = Readonly<{ rootId: string; relPath: string; sessionId: string; expiresAtMs: number }>

export class CapabilityTokens {
  readonly #grants = new Map<string, Grant>()

  issue(rootId: string, relPath: string, sessionId: string, nowMs = Date.now()): string {
    const token = randomBytes(16).toString('hex')
    this.#grants.set(token, { rootId, relPath, sessionId, expiresAtMs: nowMs + TOKEN_TTL_MS })
    return token
  }

  redeem(token: string, sessionId: string, nowMs = Date.now()): Grant | undefined {
    const grant = this.#grants.get(token)
    if (grant?.sessionId !== sessionId || grant.expiresAtMs <= nowMs) return undefined
    return grant
  }

  renew(token: string, sessionId: string, nowMs = Date.now()): boolean {
    const grant = this.redeem(token, sessionId, nowMs)
    if (!grant) return false
    this.#grants.set(token, { ...grant, expiresAtMs: nowMs + TOKEN_TTL_MS })
    return true
  }
}

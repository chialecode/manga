import { expect, it } from 'vitest'
import { CapabilityTokens } from '../token.js'

it('binds tokens to a session and expires them', () => {
  const tokens = new CapabilityTokens()
  const token = tokens.issue('root', 'safe/item.bin', 'window-a', 0)
  expect(token).toMatch(/^[a-f0-9]{32}$/u)
  expect(tokens.redeem(token, 'window-a', 1)).toMatchObject({ rootId: 'root', relPath: 'safe/item.bin', sessionId: 'window-a' })
  expect(tokens.redeem(token, 'window-b', 1)).toBeUndefined()
  expect(tokens.redeem(token, 'window-a', 30 * 60 * 1000)).toBeUndefined()
})

it('renews only a valid session-bound token', () => {
  const tokens = new CapabilityTokens()
  const token = tokens.issue('root', 'safe/item.bin', 'window-a', 0)
  expect(tokens.renew(token, 'window-b', 1)).toBe(false)
  expect(tokens.renew(token, 'window-a', 1)).toBe(true)
  expect(tokens.redeem(token, 'window-a', 30 * 60 * 1000)).toBeDefined()
})

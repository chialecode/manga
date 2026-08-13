import { protocol } from 'electron'
import { SCHEME_BOOK, SCHEME_MEDIA } from '@manga/contract'
import { RootRegistry } from '../capability-gate/roots.js'
import { CapabilityTokens } from '../capability-gate/token.js'
import { resolveAuthorizedPath } from '../capability-gate/resolve.js'
import { bookResponse } from './book.js'
import { mediaResponse } from './media.js'

protocol.registerSchemesAsPrivileged([
  {
    scheme: SCHEME_MEDIA,
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      stream: true,
      corsEnabled: false,
      bypassCSP: false,
    },
  },
  {
    scheme: SCHEME_BOOK,
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      stream: false,
      corsEnabled: false,
      bypassCSP: false,
    },
  },
])

export type ProtocolCapabilities = Readonly<{
  roots: RootRegistry
  tokens: CapabilityTokens
}>

function tokenAndSubPath(request: Request): Readonly<{ token: string; subPath: string }> | undefined {
  const url = new URL(request.url)
  const token = url.hostname
  const subPath = decodeURIComponent(url.pathname.replace(/^\//u, ''))
  if (!token || !subPath) return undefined
  return { token, subPath }
}

export async function installCapabilityProtocols(sessionId: string, rootsPath: string): Promise<ProtocolCapabilities> {
  const roots = await RootRegistry.load(rootsPath)
  const tokens = new CapabilityTokens()
  protocol.handle(SCHEME_MEDIA, async (request) => {
    const parsed = tokenAndSubPath(request)
    const grant = parsed ? tokens.redeem(parsed.token, sessionId) : undefined
    if (!parsed || !grant) return new Response(null, { status: 404 })
    try {
      const path = await resolveAuthorizedPath(roots, grant.rootId, grant.relPath)
      return await mediaResponse(path, request.headers.get('Range'), `${grant.rootId}:${grant.relPath}`)
    } catch {
      return new Response(null, { status: 404 })
    }
  })
  protocol.handle(SCHEME_BOOK, async (request) => {
    const parsed = tokenAndSubPath(request)
    const grant = parsed ? tokens.redeem(parsed.token, sessionId) : undefined
    if (!parsed || !grant) return new Response(null, { status: 404 })
    try {
      const path = await resolveAuthorizedPath(roots, grant.rootId, `${grant.relPath}/${parsed.subPath}`)
      return await bookResponse(path)
    } catch {
      return new Response(null, { status: 404 })
    }
  })
  return { roots, tokens }
}

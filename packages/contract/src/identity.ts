declare const __BUILD_CHANNEL__: 'stable' | 'dev'

export type BuildChannel = 'stable' | 'dev'

export function identityForChannel(channel: BuildChannel) {
  return Object.freeze({
    channel,
    appDirName: channel === 'dev' ? 'manga-dev' : 'manga',
    appId: channel === 'dev' ? 'app.manga.desktop.dev' : 'app.manga.desktop',
    deepLinkScheme: channel === 'dev' ? 'manga-dev' : 'manga',
    displayName: channel === 'dev' ? 'MANGA Dev' : 'MANGA',
  })
}

export const CHANNEL: BuildChannel = typeof __BUILD_CHANNEL__ === 'undefined' ? 'dev' : __BUILD_CHANNEL__
const CURRENT_IDENTITY = identityForChannel(CHANNEL)
export const APP_DIR_NAME = CURRENT_IDENTITY.appDirName
export const APP_ID = CURRENT_IDENTITY.appId
export const DEEP_LINK_SCHEME = CURRENT_IDENTITY.deepLinkScheme
export const DISPLAY_NAME = CURRENT_IDENTITY.displayName
export const SCHEME_MEDIA = 'media'
export const SCHEME_BOOK = 'book'

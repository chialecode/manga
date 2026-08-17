import { SCHEME_BOOK, SCHEME_MEDIA } from '@manga/contract'

export const APP_CSP = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  `img-src 'self' ${SCHEME_MEDIA}: data: blob:`,
  `media-src 'self' ${SCHEME_MEDIA}: blob:`,
  "font-src 'self'",
  "connect-src 'self'",
  `frame-src ${SCHEME_BOOK}:`,
  "worker-src 'self' blob:",
  "form-action 'none'",
  "base-uri 'none'",
].join('; ')

export const BOOK_CSP = [
  "default-src 'none'",
  "script-src 'none'",
  `style-src 'unsafe-inline' ${SCHEME_BOOK}:`,
  `img-src ${SCHEME_BOOK}: data:`,
  `font-src ${SCHEME_BOOK}:`,
].join('; ')

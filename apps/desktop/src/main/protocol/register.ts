import { protocol } from 'electron'
import { SCHEME_BOOK, SCHEME_MEDIA } from '@manga/contract'

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

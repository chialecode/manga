import { createHash } from 'node:crypto'

const SECRET_KEY = /api.?key|authorization|credential|password|secret/iu
const TOKEN_KEY = /token/iu
const TITLE_KEY = /title|bookName|workName|fileName/iu
const ABSOLUTE_PATH = /(?:[A-Za-z]:[\\/]|\\\\[^\\/\s]+[\\/][^\\/\s]+[\\/]|\/(?:Users|home|mnt|media|var|tmp)\/)[^\s"']+/gu

function pathPlaceholder(path: string): string {
  return `<root>/<${createHash('sha1').update(path).digest('hex').slice(0, 8)}>`
}

export function redact(value: unknown, key = ''): unknown {
  if (SECRET_KEY.test(key)) return '<redacted>'
  if (typeof value === 'string') {
    if (TOKEN_KEY.test(key)) return '<token>'
    if (TITLE_KEY.test(key)) return '<title>'
    return value.replace(ABSOLUTE_PATH, pathPlaceholder)
  }
  if (Array.isArray(value)) return value.map((item) => redact(item))
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([entryKey, entry]) => [entryKey, redact(entry, entryKey)]))
  return value
}

type Redactor = (value: unknown) => unknown

export function serializeLog(record: Readonly<Record<string, unknown>>, redactor: Redactor = redact): string {
  return `${JSON.stringify(redactor(record))}\n`
}

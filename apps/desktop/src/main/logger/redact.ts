import { createHash } from 'node:crypto'

const SECRET_KEY = /api.?key|authorization|credential|password|secret/iu
const WINDOWS_PATH = /[A-Za-z]:\\[^\s"']+/gu

export function redact(value: unknown, key = ''): unknown {
  if (SECRET_KEY.test(key)) return '<redacted>'
  if (typeof value === 'string') {
    if (/token/iu.test(key)) return '<token>'
    if (/title|bookName|workName/iu.test(key)) return '<title>'
    return value.replace(WINDOWS_PATH, (path) => `<root>/<${createHash('sha1').update(path).digest('hex').slice(0, 8)}>`)
  }
  if (Array.isArray(value)) return value.map((item) => redact(item))
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([entryKey, entry]) => [entryKey, redact(entry, entryKey)]))
  return value
}

import { createHash } from 'node:crypto'

export function migrationReplayViolations(database) {
  const required = ['archive_entry', 'file', 'file_path_history', 'library_root', 'task']
  const present = new Set(database.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((row) => row.name))
  return required.filter((table) => !present.has(table)).map((table) => `migration replay lacks ${table}`)
}

export function thirdPartyNoticeViolations(lock, notice) {
  const hash = createHash('sha256').update(lock).digest('hex')
  return notice.includes(hash) ? [] : ['third-party notices are stale']
}

export function redactionViolations(redacted, secrets) {
  const output = JSON.stringify(redacted)
  return secrets.filter((secret) => output.includes(secret)).map((secret) => `logger emitted ${secret}`)
}

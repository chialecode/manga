import { createHash } from 'node:crypto'

export function migrationReplayViolations(database) {
  const required = ['archive_entry', 'file', 'file_path_history', 'library_root', 'task']
  const present = new Set(database.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((row) => row.name))
  return required.filter((table) => !present.has(table)).map((table) => `migration replay lacks ${table}`)
}

export function thirdPartyNoticeViolations(lock, notice, sbomSource = '{}') {
  const violations = []
  const hash = createHash('sha256').update(lock).digest('hex')
  if (!notice.includes(hash)) violations.push('third-party notices are stale')
  if (!/^- .+ \S+ - \S+/mu.test(notice) || !notice.includes('FFmpeg source:')) violations.push('third-party notices lack package or FFmpeg license data')
  let sbom
  try { sbom = JSON.parse(sbomSource) } catch { return [...violations, 'SBOM is not valid JSON'] }
  if (!Array.isArray(sbom.packages) || sbom.packages.length < 2) violations.push('SBOM lacks package inventory')
  if (!Array.isArray(sbom.relationships) || !sbom.relationships.some((item) => item.relationshipType === 'DEPENDS_ON')) violations.push('SBOM lacks dependency relationships')
  return violations
}

export function redactionViolations(redacted, secrets) {
  const output = JSON.stringify(redacted)
  return secrets.filter((secret) => output.includes(secret)).map((secret) => `logger emitted ${secret}`)
}

import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'

export async function sha256(path) {
  return createHash('sha256').update(await readFile(path)).digest('hex')
}

export function vendorManifestViolations(manifest) {
  const item = manifest.ffmpeg
  const violations = []
  if (/latest/iu.test(item.url)) violations.push('vendor URL must not contain latest')
  if (!/autobuild-\d{4}-(?:01-31|02-(?:28|29)|03-31|04-30|05-31|06-30|07-31|08-31|09-30|10-31|11-30|12-31)-/u.test(item.url)) {
    violations.push('vendor URL must identify a month-end retained build')
  }
  if (!/lgpl-shared/iu.test(item.url) || /nonfree/iu.test(item.url)) violations.push('vendor must be LGPL shared')
  if (!/ffmpeg-\d+\.\d+(?:\.\d+)?\.tar\.xz$/u.test(item.sourceUrl)) violations.push('source tarball URL is required')
  if (!/^[a-f0-9]{64}$/u.test(item.archiveSha256)) violations.push('archive sha256 is invalid')
  return violations
}

export async function installedVendorViolations(directory, manifest) {
  const violations = []
  for (const [file, expected] of Object.entries(manifest.ffmpeg.files)) {
    try {
      if ((await sha256(`${directory}/${file}`)) !== expected) violations.push(`${file}: sha256 mismatch`)
    } catch {
      violations.push(`${file}: missing`)
    }
  }
  return violations
}

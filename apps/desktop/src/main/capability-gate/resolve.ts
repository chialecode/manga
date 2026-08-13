import { realpath } from 'node:fs/promises'
import { isAbsolute, relative, resolve, sep } from 'node:path'
import type { RootRegistry } from './roots.js'

const DEVICE_NAME = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i
const SHORT_NAME = /^[a-z0-9]{1,6}~[1-9](?:\.[^\\/]+)?$/iu
const MAX_RELATIVE_PATH_LENGTH = 32767

function decodeCompletely(input: string): string {
  let current = input
  for (let pass = 0; pass < 3; pass += 1) {
    let decoded: string
    try {
      decoded = decodeURIComponent(current)
    } catch {
      throw new Error('Invalid path encoding')
    }
    if (decoded === current) return decoded
    current = decoded
  }
  return current
}

function containsDeviceName(path: string): boolean {
  return path.split(/[\\/]/u).some((segment) => DEVICE_NAME.test(segment.replace(/[ .]+$/u, '')) || SHORT_NAME.test(segment))
}

export async function resolveAuthorizedPath(registry: RootRegistry, rootId: string, relPath: string): Promise<string> {
  const root = registry.getEnabled(rootId)
  if (!root) throw new Error('Library root is not authorized')

  const normalized = decodeCompletely(relPath).normalize('NFC')
  if (normalized.length === 0 || normalized === '.' || normalized.includes('\0')) throw new Error('Invalid relative path')
  if (normalized.length > MAX_RELATIVE_PATH_LENGTH) throw new Error('Path is too long')
  if (isAbsolute(normalized) || /^[a-z]:/iu.test(normalized) || normalized.startsWith('\\\\')) {
    throw new Error('Absolute paths are forbidden')
  }
  if (containsDeviceName(normalized)) throw new Error('Reserved device name')

  const rootReal = await realpath(root.path)
  const candidate = resolve(rootReal, normalized)
  const candidateReal = await realpath(candidate)
  const fromRoot = relative(rootReal, candidateReal)
  if (fromRoot === '' || fromRoot === '..' || fromRoot.startsWith(`..${sep}`) || isAbsolute(fromRoot)) {
    throw new Error('Resolved path escapes library root')
  }
  return candidateReal
}

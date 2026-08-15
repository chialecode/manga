import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { resolveAuthorizedPath } from '../resolve.js'
import { RootRegistry } from '../roots.js'

let root = ''
// The authorized root is registered as returned by mkdtemp, which on some
// Windows hosts contains an 8.3 alias (a GitHub runner's TMP is under
// C:\Users\RUNNER~1). The gate canonicalizes it, so accepted paths must be
// compared against the resolved root rather than the raw fixture string.
let rootReal = ''
let outside = ''
let registry: RootRegistry

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'cap-root-'))
  rootReal = await realpath(root)
  outside = await mkdtemp(join(tmpdir(), 'cap-outside-'))
  await mkdir(join(root, 'safe'))
  await writeFile(join(root, 'safe', 'item.bin'), 'x')
  await writeFile(join(outside, 'secret.bin'), 'x')
  registry = new RootRegistry()
  registry.authorize({ id: 'root', path: root, enabled: true })
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
  await rm(outside, { recursive: true, force: true })
})

describe('CapabilityGate traversal rejection', () => {
  it.each([
    '../secret.bin', '..\\secret.bin', '%2e%2e/secret.bin', '%252e%252e%252fsecret.bin',
  ])('rejects an existing outside-root target: %s', async (attack) => {
    const siblingRoot = dirname(root)
    const siblingOutside = join(siblingRoot, basename(outside))
    const actual = attack.replace(/secret\.bin$/u, `${basename(siblingOutside)}/secret.bin`)
    await expect(resolveAuthorizedPath(registry, 'root', actual)).rejects.toThrow('Resolved path escapes library root')
  })

  it.each(['\\\\server\\share\\file', '\\\\?\\C:\\file', 'C:\\Windows\\file', '/absolute/file'])('rejects absolute path: %s', async (attack) => {
    await expect(resolveAuthorizedPath(registry, 'root', attack)).rejects.toThrow('Absolute paths are forbidden')
  })

  it.each(['CON', 'safe/NUL.txt', 'safe/COM1'])('rejects reserved device name: %s', async (attack) => {
    await expect(resolveAuthorizedPath(registry, 'root', attack)).rejects.toThrow('Reserved device name')
  })

  it('rejects Windows 8.3 short-name aliases', async () => {
    await writeFile(join(root, 'safe', 'PROGRA~1'), 'x')
    await expect(resolveAuthorizedPath(registry, 'root', 'safe/PROGRA~1')).rejects.toThrow('Reserved device name')
  })

  it('rejects an overlong relative path before filesystem resolution', async () => {
    await expect(resolveAuthorizedPath(registry, 'root', `safe/${'a'.repeat(33000)}`)).rejects.toThrow('Path is too long')
  })

  it.each(['', '.', 'safe/\0item'])('rejects invalid relative input: %s', async (attack) => {
    await expect(resolveAuthorizedPath(registry, 'root', attack)).rejects.toThrow('Invalid relative path')
  })

  it('rejects symlink or junction escape', async () => {
    const link = join(root, 'escape')
    await symlink(outside, link, 'junction')
    await expect(resolveAuthorizedPath(registry, 'root', 'escape/secret.bin')).rejects.toThrow(/escapes/)
  })

  it('accepts an existing in-root file', async () => {
    await expect(resolveAuthorizedPath(registry, 'root', 'safe/item.bin')).resolves.toBe(join(rootReal, 'safe', 'item.bin'))
  })

  it('normalizes Unicode path variants before resolving inside the root', async () => {
    const composed = 'caf\u00e9.bin'
    await writeFile(join(root, 'safe', composed), 'x')
    await expect(resolveAuthorizedPath(registry, 'root', `safe/${composed.normalize('NFD')}`)).resolves.toBe(join(rootReal, 'safe', composed))
  })
})

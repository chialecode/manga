import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { resolveAuthorizedPath } from '../resolve.js'
import { RootRegistry } from '../roots.js'

let root = ''
let outside = ''
let registry: RootRegistry

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'cap-root-'))
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
  const attacks = [
    '../secret.bin', '..\\secret.bin', '../..\\secret.bin', '%2e%2e/secret.bin',
    '%252e%252e%252fsecret.bin', '\\\\server\\share\\file', '\\\\?\\C:\\file',
    'C:\\Windows\\file', '/absolute/file', 'CON', 'safe/NUL.txt', 'safe/COM1', '', '.',
    `safe/${'a'.repeat(33000)}`, 'safe/\0item',
  ]

  it.each(attacks)('rejects %s', async (attack) => {
    await expect(resolveAuthorizedPath(registry, 'root', attack)).rejects.toBeInstanceOf(Error)
  })

  it('rejects symlink or junction escape', async () => {
    const link = join(root, 'escape')
    await symlink(outside, link, 'junction')
    await expect(resolveAuthorizedPath(registry, 'root', 'escape/secret.bin')).rejects.toThrow(/escapes/)
  })

  it('accepts an existing in-root file', async () => {
    await expect(resolveAuthorizedPath(registry, 'root', 'safe/item.bin')).resolves.toBe(join(root, 'safe', 'item.bin'))
  })
})

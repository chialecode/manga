import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { RootRegistry } from '../roots.js'

it('persists authorized roots only to the explicit application config path', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'root-registry-'))
  try {
    const mediaDirectory = join(directory, 'media')
    const sentinel = join(mediaDirectory, 'sentinel.txt')
    const config = join(directory, 'app-data', 'roots.json')
    await mkdir(mediaDirectory)
    await writeFile(sentinel, 'unchanged')
    const registry = new RootRegistry()
    registry.authorize({ id: 'root', path: mediaDirectory, enabled: true })
    await registry.save(config)
    const loaded = await RootRegistry.load(config)
    expect(loaded.getEnabled('root')).toEqual({ id: 'root', path: mediaDirectory, enabled: true })
    expect(await readFile(sentinel, 'utf8')).toBe('unchanged')
  } finally { await rm(directory, { recursive: true, force: true }) }
})

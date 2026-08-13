import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, basename } from 'node:path'

const root = await mkdtemp(join(tmpdir(), 'channel-isolation-'))
const executables = [
  join(process.cwd(), 'apps', 'desktop', 'out', 'manga-win32-x64', 'manga.exe'),
  join(process.cwd(), 'apps', 'desktop', 'out', 'manga-dev-win32-x64', 'manga-dev.exe'),
]
const children = []
try {
  for (const executable of executables) {
    const channelDir = basename(executable, '.exe')
    const child = spawn(executable, [], {
      env: { ...process.env, APPDATA: join(root, channelDir, 'roaming'), LOCALAPPDATA: join(root, channelDir, 'local') },
      windowsHide: true,
    })
    children.push({ channelDir, child })
  }
  const deadline = Date.now() + 20_000
  for (const { channelDir } of children) {
    const databasePath = join(root, channelDir, 'roaming', channelDir, 'data.sqlite')
    while (!existsSync(databasePath) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 100))
    assert.equal(existsSync(databasePath), true, `${channelDir} did not create isolated database`)
  }
  assert.equal(existsSync(join(root, 'manga-win32-x64', 'roaming', 'manga-dev', 'data.sqlite')), false)
  assert.equal(existsSync(join(root, 'manga-dev-win32-x64', 'roaming', 'manga', 'data.sqlite')), false)
  process.stdout.write(JSON.stringify({ isolated: true, channels: children.map(({ channelDir }) => channelDir) }) + '\n')
} finally {
  for (const { child } of children) {
    if (child.pid) spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true })
  }
  await rm(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 250 })
}

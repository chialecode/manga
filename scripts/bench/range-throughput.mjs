import { spawnSync } from 'node:child_process'
import { resolve } from 'node:path'

const path = process.argv[2]
if (!path) throw new Error('Provide a local benchmark file path of at least 64 MiB')
const root = process.cwd()
const desktop = resolve(root, 'apps/desktop')
const vite = resolve(root, 'node_modules/vite/bin/vite.js')
const build = spawnSync(process.execPath, [vite, 'build', '--config', 'vite.range-bench.config.ts'], {
  cwd: desktop, stdio: 'inherit', windowsHide: true,
})
if (build.error) throw build.error
if (build.status !== 0) process.exit(build.status ?? 1)
const benchmark = spawnSync(process.execPath, [resolve(desktop, '.vite/build/range-bench.cjs'), resolve(root, path)], {
  stdio: 'inherit', windowsHide: true,
})
if (benchmark.error) throw benchmark.error
process.exitCode = benchmark.status ?? 1

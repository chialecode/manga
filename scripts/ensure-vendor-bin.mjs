import { spawnSync } from 'node:child_process'
import { cp, mkdtemp, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { installedVendorViolations, sha256, vendorManifestViolations } from './lib/vendor.mjs'

const manifest = JSON.parse(await readFile(new URL('./vendor-bin.manifest.json', import.meta.url), 'utf8'))
const target = join(process.cwd(), 'vendor-bin', 'ffmpeg')
const targetParent = dirname(target)
const manifestViolations = vendorManifestViolations(manifest)
if (manifestViolations.length > 0) throw new Error(manifestViolations.join('\n'))
if (process.argv[2] !== '--force' && (await installedVendorViolations(target, manifest)).length === 0) process.exit(0)

const temporary = await mkdtemp(join(tmpdir(), 'vendor-bin-'))
await mkdir(targetParent, { recursive: true })
const localStageRoot = await mkdtemp(join(targetParent, '.staging-'))
try {
  const archive = join(temporary, 'ffmpeg.zip')
  const extracted = join(temporary, 'extracted')
  const staged = join(temporary, 'verified')
  const response = await fetch(manifest.ffmpeg.url)
  if (!response.ok) throw new Error(`Vendor download failed: ${String(response.status)}`)
  await writeFile(archive, Buffer.from(await response.arrayBuffer()))
  if ((await sha256(archive)) !== manifest.ffmpeg.archiveSha256) throw new Error('Vendor archive sha256 mismatch')

  await mkdir(extracted)
  const expand = spawnSync('tar.exe', ['-xf', archive, '-C', extracted], { encoding: 'utf8' })
  if (expand.status !== 0) throw new Error(expand.stderr || 'Vendor archive extraction failed')

  const bin = join(extracted, manifest.ffmpeg.url.split('/').at(-1).replace(/\.zip$/u, ''), 'bin')
  await mkdir(staged)
  for (const file of Object.keys(manifest.ffmpeg.files)) {
    await rename(join(bin, file), join(staged, file))
  }
  const installedViolations = await installedVendorViolations(staged, manifest)
  if (installedViolations.length > 0) throw new Error(installedViolations.join('\n'))

  const localStage = join(localStageRoot, 'ffmpeg')
  await cp(staged, localStage, { recursive: true })
  const localViolations = await installedVendorViolations(localStage, manifest)
  if (localViolations.length > 0) throw new Error(localViolations.join('\n'))
  await rm(target, { recursive: true, force: true })
  await rename(localStage, target)
  process.stdout.write(`Verified vendor binary ${manifest.ffmpeg.version}.\n`)
} finally {
  await rm(temporary, { recursive: true, force: true })
  await rm(localStageRoot, { recursive: true, force: true })
}

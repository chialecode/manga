import { createHash, randomUUID } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

const lock = await readFile('pnpm-lock.yaml', 'utf8')
const manifest = JSON.parse(await readFile('scripts/vendor-bin.manifest.json', 'utf8'))
const hash = createHash('sha256').update(lock).digest('hex')

const execPath = process.env.npm_execpath
const corepackPnpm = join(dirname(process.execPath), 'node_modules', 'corepack', 'dist', 'pnpm.js')
const pnpmCli = execPath && execPath.endsWith('.js') ? execPath : existsSync(corepackPnpm) ? corepackPnpm : undefined
if (!pnpmCli) throw new Error('Unable to locate the pnpm CLI; run this generator through pnpm')
const licenseRun = spawnSync(process.execPath, [pnpmCli, 'licenses', 'list', '--json'], { encoding: 'utf8' })
if (licenseRun.status !== 0) throw new Error(`pnpm license inventory failed: ${licenseRun.stderr}`)
const licenseGroups = JSON.parse(licenseRun.stdout)
const packages = Object.entries(licenseGroups).flatMap(([license, entries]) => entries.flatMap((entry) =>
  entry.versions.map((version) => ({ name: entry.name, version, license })),
)).sort((left, right) => `${left.name}@${left.version}`.localeCompare(`${right.name}@${right.version}`))

const notices = []
const spdxPackages = []
for (const coordinate of packages) {
  const license = coordinate.license
  notices.push(`- ${coordinate.name} ${coordinate.version} - ${license}`)
  spdxPackages.push({
    SPDXID: `SPDXRef-Package-${spdxPackages.length + 1}`,
    name: coordinate.name,
    versionInfo: coordinate.version,
    downloadLocation: 'NOASSERTION',
    filesAnalyzed: false,
    licenseConcluded: license,
    licenseDeclared: license,
    copyrightText: 'NOASSERTION',
  })
}

const ffmpeg = manifest.ffmpeg
notices.push(`- FFmpeg ${ffmpeg.version} - LGPL-2.1-or-later`)
const ffmpegId = 'SPDXRef-Package-FFmpeg'
spdxPackages.push({ SPDXID: ffmpegId, name: 'FFmpeg', versionInfo: ffmpeg.version, downloadLocation: ffmpeg.url, filesAnalyzed: false, licenseConcluded: 'LGPL-2.1-or-later', licenseDeclared: 'LGPL-2.1-or-later', copyrightText: 'NOASSERTION', sourceInfo: ffmpeg.sourceUrl })

const notice = `# Third-Party Notices\n\nGenerated from pnpm-lock.yaml. Package licenses are taken from installed package metadata.\n\n${notices.join('\n')}\n\nFFmpeg source: ${ffmpeg.sourceUrl}\nFFmpeg build: ${ffmpeg.url}\n\nLockfile-SHA256: ${hash}\n`
const documentId = 'SPDXRef-DOCUMENT'
const rootId = 'SPDXRef-RootPackage'
const sbom = {
  spdxVersion: 'SPDX-2.3',
  dataLicense: 'CC0-1.0',
  SPDXID: documentId,
  name: 'desktop-client-sbom',
  documentNamespace: `urn:uuid:${randomUUID()}`,
  creationInfo: { created: new Date().toISOString(), creators: ['Tool: scripts/generate-third-party-notices.mjs'] },
  lockfileSha256: hash,
  packages: [{ SPDXID: rootId, name: 'desktop-client', versionInfo: '0.0.1', downloadLocation: 'NOASSERTION', filesAnalyzed: false, licenseConcluded: 'Apache-2.0', licenseDeclared: 'Apache-2.0', copyrightText: 'NOASSERTION' }, ...spdxPackages],
  relationships: [
    { spdxElementId: documentId, relationshipType: 'DESCRIBES', relatedSpdxElement: rootId },
    ...spdxPackages.map((item) => ({ spdxElementId: rootId, relationshipType: 'DEPENDS_ON', relatedSpdxElement: item.SPDXID })),
  ],
}
await writeFile('THIRD-PARTY-NOTICES.md', notice)
await writeFile('sbom.spdx.json', `${JSON.stringify(sbom, null, 2)}\n`)

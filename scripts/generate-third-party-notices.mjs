import { createHash, randomUUID } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'

// Optional output directory so the guard can generate into a scratch location
// instead of mutating the committed artifacts it is supposed to be checking.
const outputDirectory = resolve(process.argv[2] ?? '.')

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
const rootPackage = { SPDXID: rootId, name: 'desktop-client', versionInfo: '0.0.1', downloadLocation: 'NOASSERTION', filesAnalyzed: false, licenseConcluded: 'Apache-2.0', licenseDeclared: 'Apache-2.0', copyrightText: 'NOASSERTION' }
const allPackages = [rootPackage, ...spdxPackages]
const relationships = [
  { spdxElementId: documentId, relationshipType: 'DESCRIBES', relatedSpdxElement: rootId },
  ...spdxPackages.map((item) => ({ spdxElementId: rootId, relationshipType: 'DEPENDS_ON', relatedSpdxElement: item.SPDXID })),
]

// Regenerating an unchanged inventory must not churn the committed document.
// Reuse the previous namespace and creation time when nothing but those two
// fields would differ, so running the guard leaves the working tree clean.
const sbomPath = join(outputDirectory, 'sbom.spdx.json')
let previous
try {
  previous = JSON.parse(await readFile(sbomPath, 'utf8'))
} catch {
  previous = undefined
}
const unchanged =
  previous?.lockfileSha256 === hash &&
  JSON.stringify(previous.packages) === JSON.stringify(allPackages) &&
  JSON.stringify(previous.relationships) === JSON.stringify(relationships)

const sbom = {
  spdxVersion: 'SPDX-2.3',
  dataLicense: 'CC0-1.0',
  SPDXID: documentId,
  name: 'desktop-client-sbom',
  documentNamespace: unchanged ? previous.documentNamespace : `urn:uuid:${randomUUID()}`,
  creationInfo: {
    created: unchanged ? previous.creationInfo.created : new Date().toISOString(),
    creators: ['Tool: scripts/generate-third-party-notices.mjs'],
  },
  lockfileSha256: hash,
  packages: allPackages,
  relationships,
}
await mkdir(outputDirectory, { recursive: true })
await writeFile(join(outputDirectory, 'THIRD-PARTY-NOTICES.md'), notice)
await writeFile(sbomPath, `${JSON.stringify(sbom, null, 2)}\n`)

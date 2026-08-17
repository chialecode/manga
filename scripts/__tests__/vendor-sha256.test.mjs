import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { installedVendorViolations, vendorManifestViolations } from '../lib/vendor.mjs'

const manifest = JSON.parse(await readFile('scripts/vendor-bin.manifest.json', 'utf8'))

test('vendor manifest pins a retained LGPL build and installed hashes', async () => {
  assert.deepEqual(vendorManifestViolations(manifest), [])
  assert.deepEqual(await installedVendorViolations('vendor-bin/ffmpeg', manifest), [])
})

test('counterexample: latest build URL is rejected', () => {
  const bad = structuredClone(manifest)
  bad.ffmpeg.url = bad.ffmpeg.url.replace(/autobuild-[^/]+/u, 'latest')
  assert.match(vendorManifestViolations(bad)[0] ?? '', /latest/)
})

test('counterexample: changed version without a matching archive hash is rejected', () => {
  const bad = structuredClone(manifest)
  bad.ffmpeg.archiveSha256 = 'unchanged'
  assert.match(vendorManifestViolations(bad).join('\n'), /sha256/)
})

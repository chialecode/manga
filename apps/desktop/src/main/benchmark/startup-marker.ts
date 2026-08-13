import { writeFile } from 'node:fs/promises'

export async function writeBenchmarkMarker(path: string, visibleAtMs: number): Promise<void> {
  if (!__STARTUP_BENCHMARK__) throw new Error('Startup benchmark support is not present in release builds')
  await writeFile(path, String(visibleAtMs), { flag: 'wx' })
}

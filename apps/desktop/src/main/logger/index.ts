import { appendFile, mkdir } from 'node:fs/promises'
import { dirname } from 'node:path'
import { redact } from './redact.js'

export async function writeLog(path: string, record: Readonly<Record<string, unknown>>): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  await appendFile(path, `${JSON.stringify(redact(record))}\n`, 'utf8')
}

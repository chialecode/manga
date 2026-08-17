import { appendFile, mkdir } from 'node:fs/promises'
import { dirname } from 'node:path'
import { serializeLog } from './redact.js'

export async function writeLog(path: string, record: Readonly<Record<string, unknown>>): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  await appendFile(path, serializeLog(record), 'utf8')
}

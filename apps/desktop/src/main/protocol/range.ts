export type ByteRange = Readonly<{ start: number; end: number }>

export function parseRange(header: string | null, size: number): ByteRange | undefined {
  if (!header) return undefined
  const match = /^bytes=(\d*)-(\d*)$/u.exec(header)
  if (!match || (match[1] === '' && match[2] === '')) throw new Error('Invalid Range header')
  const first = match[1] ?? ''
  const second = match[2] ?? ''
  if (first === '') {
    const suffix = Number(second)
    if (!Number.isInteger(suffix) || suffix <= 0) throw new Error('Invalid suffix range')
    return { start: Math.max(0, size - suffix), end: size - 1 }
  }
  const start = Number(first)
  const end = second === '' ? size - 1 : Number(second)
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end < start || start >= size) {
    throw new Error('Unsatisfiable Range header')
  }
  return { start, end: Math.min(end, size - 1) }
}

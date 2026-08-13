import { expect, it } from 'vitest'
import { parseRange } from '../range.js'

it('parses bounded, open, and suffix ranges', () => {
  expect(parseRange('bytes=10-19', 100)).toEqual({ start: 10, end: 19 })
  expect(parseRange('bytes=90-', 100)).toEqual({ start: 90, end: 99 })
  expect(parseRange('bytes=-10', 100)).toEqual({ start: 90, end: 99 })
})

it('rejects unsatisfiable ranges', () => {
  expect(() => parseRange('bytes=100-101', 100)).toThrow(/Unsatisfiable/)
  expect(() => parseRange('items=0-1', 100)).toThrow(/Invalid/)
})

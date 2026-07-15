import { describe, it, expect } from 'vitest'
import { formatBytes } from '../syncPrecheck'

describe('formatBytes', () => {
  it('formats bytes below 1 KB', () => {
    expect(formatBytes(0)).toBe('0 B')
    expect(formatBytes(512)).toBe('512 B')
  })

  it('formats kilobytes', () => {
    expect(formatBytes(1024)).toBe('1.0 KB')
    expect(formatBytes(10 * 1024)).toBe('10.0 KB')
  })

  it('formats megabytes with one decimal', () => {
    expect(formatBytes(1024 * 1024)).toBe('1.0 MB')
    expect(formatBytes(10 * 1024 * 1024)).toBe('10.0 MB')
  })

  it('formats gigabytes with two decimals', () => {
    expect(formatBytes(1024 * 1024 * 1024)).toBe('1.00 GB')
  })
})

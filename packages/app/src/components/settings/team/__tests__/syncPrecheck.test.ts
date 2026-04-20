import { describe, it, expect } from 'vitest'
import {
  shouldShowPrecheckWarning,
  formatBytes,
  MAX_NEW_FILE_COUNT,
  MAX_SINGLE_FILE_BYTES,
  MAX_TOTAL_NEW_BYTES,
} from '../syncPrecheck'

describe('shouldShowPrecheckWarning', () => {
  it('returns false when nothing exceeds any threshold', () => {
    expect(
      shouldShowPrecheckWarning({
        newFiles: [{ path: 'a.txt', sizeBytes: 1024 }],
        totalBytes: 1024,
      }),
    ).toBe(false)
  })

  it('returns false for empty file list', () => {
    expect(
      shouldShowPrecheckWarning({ newFiles: [], totalBytes: 0 }),
    ).toBe(false)
  })

  it('returns true when file count exceeds MAX_NEW_FILE_COUNT', () => {
    const newFiles = Array.from({ length: MAX_NEW_FILE_COUNT + 1 }, (_, i) => ({
      path: `f${i}.txt`,
      sizeBytes: 10,
    }))
    expect(
      shouldShowPrecheckWarning({ newFiles, totalBytes: newFiles.length * 10 }),
    ).toBe(true)
  })

  it('returns false when file count equals MAX_NEW_FILE_COUNT (inclusive boundary)', () => {
    const newFiles = Array.from({ length: MAX_NEW_FILE_COUNT }, (_, i) => ({
      path: `f${i}.txt`,
      sizeBytes: 10,
    }))
    expect(
      shouldShowPrecheckWarning({ newFiles, totalBytes: newFiles.length * 10 }),
    ).toBe(false)
  })

  it('returns true when any single file exceeds MAX_SINGLE_FILE_BYTES', () => {
    expect(
      shouldShowPrecheckWarning({
        newFiles: [{ path: 'big.mp4', sizeBytes: MAX_SINGLE_FILE_BYTES + 1 }],
        totalBytes: MAX_SINGLE_FILE_BYTES + 1,
      }),
    ).toBe(true)
  })

  it('returns true when total exceeds MAX_TOTAL_NEW_BYTES even if each file is small', () => {
    // 30 files × 5 MB = 150 MB total (over 100 MB limit), but none individually > 10 MB
    const newFiles = Array.from({ length: 30 }, (_, i) => ({
      path: `f${i}.bin`,
      sizeBytes: 5 * 1024 * 1024,
    }))
    const totalBytes = newFiles.reduce((sum, f) => sum + f.sizeBytes, 0)
    expect(totalBytes).toBeGreaterThan(MAX_TOTAL_NEW_BYTES)
    expect(shouldShowPrecheckWarning({ newFiles, totalBytes })).toBe(true)
  })
})

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

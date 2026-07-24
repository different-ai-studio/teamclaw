import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  clearConsoleCapture,
  getConsoleEntries,
  installConsoleCapture,
  resetConsoleCaptureForTests,
} from '@/lib/console-capture'

describe('console-capture', () => {
  const originals = {
    debug: console.debug,
    info: console.info,
    log: console.log,
    warn: console.warn,
    error: console.error,
  }

  beforeEach(() => {
    resetConsoleCaptureForTests()
    clearConsoleCapture()
    console.debug = originals.debug
    console.info = originals.info
    console.log = originals.log
    console.warn = originals.warn
    console.error = originals.error
    installConsoleCapture()
  })

  afterEach(() => {
    console.debug = originals.debug
    console.info = originals.info
    console.log = originals.log
    console.warn = originals.warn
    console.error = originals.error
  })

  it('captures console output into the ring buffer', () => {
    console.log('hello', { ok: true })
    const entries = getConsoleEntries()
    expect(entries.length).toBe(1)
    expect(entries[0]?.level).toBe('log')
    expect(entries[0]?.message).toContain('hello')
  })

  it('still forwards to the original console methods', () => {
    const forwarded = vi.fn()
    console.warn = forwarded
    resetConsoleCaptureForTests()
    installConsoleCapture()
    console.warn('forward me')
    expect(forwarded).toHaveBeenCalledWith('forward me')
    expect(getConsoleEntries()).toHaveLength(1)
  })

  it('redacts bearer tokens in captured output', () => {
    console.info('auth Bearer secret-token-value')
    const entry = getConsoleEntries()[0]
    expect(entry?.message).toContain('Bearer [redacted]')
    expect(entry?.message).not.toContain('secret-token-value')
  })

  it('filters by level and search', () => {
    console.debug('debug line')
    console.error('error line')
    expect(getConsoleEntries({ level: 'error' })).toHaveLength(1)
    expect(getConsoleEntries({ search: 'debug' })).toHaveLength(1)
  })

  it('clears captured entries', () => {
    console.log('one')
    clearConsoleCapture()
    expect(getConsoleEntries()).toHaveLength(0)
  })
})

import { describe, expect, it } from 'vitest'

import {
  addDomainToConfig,
  isHostAllowed,
  isLinkHoverEnabledForHost,
  normalizeDomainEntry,
  parseLinkHoverConfig,
  removeDomainFromConfig,
} from './config'

describe('normalizeDomainEntry', () => {
  it('strips protocol, path, www, and port', () => {
    expect(normalizeDomainEntry('https://www.Example.com/path?q=1')).toBe('example.com')
    expect(normalizeDomainEntry('app.example.com:8443')).toBe('app.example.com')
  })

  it('rejects invalid hostnames', () => {
    expect(normalizeDomainEntry('')).toBeNull()
    expect(normalizeDomainEntry('not a domain')).toBeNull()
    expect(normalizeDomainEntry('-bad.com')).toBeNull()
  })
})

describe('isHostAllowed', () => {
  it('matches exact host and subdomains', () => {
    const domains = ['example.com']
    expect(isHostAllowed('example.com', domains)).toBe(true)
    expect(isHostAllowed('www.example.com', domains)).toBe(true)
    expect(isHostAllowed('app.example.com', domains)).toBe(true)
    expect(isHostAllowed('other.com', domains)).toBe(false)
  })

  it('is false when allowlist is empty', () => {
    expect(isHostAllowed('example.com', [])).toBe(false)
  })
})

describe('parseLinkHoverConfig', () => {
  it('defaults to empty allowlist', () => {
    expect(parseLinkHoverConfig(undefined)).toEqual({ domains: [] })
    expect(parseLinkHoverConfig({ domains: ['bad', 'example.com', 'example.com'] })).toEqual({
      domains: ['example.com'],
    })
  })
})

describe('isLinkHoverEnabledForHost', () => {
  it('requires a non-empty allowlist match', () => {
    expect(isLinkHoverEnabledForHost('app.example.com', { domains: ['example.com'] })).toBe(
      true,
    )
    expect(isLinkHoverEnabledForHost('app.example.com', { domains: [] })).toBe(false)
  })
})

describe('addDomainToConfig', () => {
  it('rejects invalid and duplicate domains', () => {
    const base = { domains: ['example.com'] }
    expect(addDomainToConfig(base, 'not valid')).toEqual({ ok: false, error: 'invalid' })
    expect(addDomainToConfig(base, 'example.com')).toEqual({ ok: false, error: 'duplicate' })
    expect(addDomainToConfig(base, 'other.example.com')).toEqual({
      ok: true,
      config: { domains: ['example.com', 'other.example.com'] },
    })
  })
})

describe('removeDomainFromConfig', () => {
  it('removes a domain entry', () => {
    expect(removeDomainFromConfig({ domains: ['a.com', 'b.com'] }, 'a.com')).toEqual({
      domains: ['b.com'],
    })
  })
})

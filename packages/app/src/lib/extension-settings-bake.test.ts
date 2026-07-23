import { describe, expect, it } from 'vitest'
import {
  parseExtensionPackConfig,
  parseExtensionSettingsBake,
  toSidePanelDomain,
} from './extension-settings-bake'

describe('parseExtensionSettingsBake', () => {
  it('defaults to visible settings button and empty link-hover lists', () => {
    expect(parseExtensionSettingsBake(undefined)).toEqual({
      hideButton: false,
      linkHover: { domains: [], urlPatterns: [] },
    })
  })

  it('parses hideButton and linkHover defaults', () => {
    expect(
      parseExtensionSettingsBake({
        hideButton: true,
        linkHover: {
          domains: [' accounting.i.shopee.io '],
          urlPatterns: ['*/discrepancy-details-info-v2/*', ''],
        },
      }),
    ).toEqual({
      hideButton: true,
      linkHover: {
        domains: ['accounting.i.shopee.io'],
        urlPatterns: ['*/discrepancy-details-info-v2/*'],
      },
    })
  })
})

describe('parseExtensionPackConfig', () => {
  it('parses solo and domains', () => {
    expect(
      parseExtensionPackConfig({
        solo: true,
        domains: ['*.shopee.io', 'https://accounting.i.shopee.io/*'],
        settings: { hideButton: true },
      }),
    ).toEqual({
      solo: true,
      domains: ['*.shopee.io', 'accounting.i.shopee.io'],
      settings: {
        hideButton: true,
        linkHover: { domains: [], urlPatterns: [] },
      },
    })
  })
})

describe('toSidePanelDomain', () => {
  it('strips chrome match patterns', () => {
    expect(toSidePanelDomain('https://*.shopee.io/*')).toBe('*.shopee.io')
    expect(toSidePanelDomain('Accounting.i.Shopee.io')).toBe('accounting.i.shopee.io')
  })
})

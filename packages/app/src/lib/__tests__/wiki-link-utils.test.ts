import { describe, it, expect } from 'vitest'
import { parseWikiLinkText, serializeWikiLink } from '../wiki-link-utils'

describe('parseWikiLinkText', () => {
  it('parses simple page name', () => {
    expect(parseWikiLinkText('Q2排期')).toEqual({
      target: 'Q2排期',
      alias: null,
      heading: null,
    })
  })

  it('parses alias syntax', () => {
    expect(parseWikiLinkText('Q2排期|二季度排期')).toEqual({
      target: 'Q2排期',
      alias: '二季度排期',
      heading: null,
    })
  })

  it('parses heading syntax', () => {
    expect(parseWikiLinkText('Q2排期#风险')).toEqual({
      target: 'Q2排期',
      alias: null,
      heading: '风险',
    })
  })

  it('parses heading + alias (heading first)', () => {
    expect(parseWikiLinkText('Q2排期#风险|Risk')).toEqual({
      target: 'Q2排期',
      alias: 'Risk',
      heading: '风险',
    })
  })

  it('trims whitespace', () => {
    expect(parseWikiLinkText(' Q2排期 ')).toEqual({
      target: 'Q2排期',
      alias: null,
      heading: null,
    })
  })

  it('returns empty target for empty string', () => {
    expect(parseWikiLinkText('')).toEqual({
      target: '',
      alias: null,
      heading: null,
    })
  })
})

describe('serializeWikiLink', () => {
  it('serializes simple target', () => {
    expect(serializeWikiLink({ target: 'Q2排期', alias: null, heading: null })).toBe('[[Q2排期]]')
  })

  it('serializes with alias', () => {
    expect(serializeWikiLink({ target: 'Q2排期', alias: '二季度排期', heading: null })).toBe('[[Q2排期|二季度排期]]')
  })

  it('serializes with heading', () => {
    expect(serializeWikiLink({ target: 'Q2排期', alias: null, heading: '风险' })).toBe('[[Q2排期#风险]]')
  })

  it('serializes with heading + alias', () => {
    expect(serializeWikiLink({ target: 'Q2排期', alias: 'Risk', heading: '风险' })).toBe('[[Q2排期#风险|Risk]]')
  })
})

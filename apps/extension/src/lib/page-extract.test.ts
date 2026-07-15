import { describe, it, expect } from 'vitest'
import { extractPage } from './page-extract'

function fakeDoc(title: string, url: string, bodyText: string): Document {
  return {
    title,
    location: { href: url },
    body: { innerText: bodyText },
  } as unknown as Document
}

describe('extractPage', () => {
  it('captures title, url, body innerText and empty selection', () => {
    const out = extractPage(fakeDoc('Hello', 'https://a/b', 'BODY TEXT'), { getSelection: () => null })
    expect(out).toEqual({ title: 'Hello', url: 'https://a/b', text: 'BODY TEXT', selection: '' })
  })
  it('captures selection when present', () => {
    const out = extractPage(fakeDoc('T', 'u', 'BODY'), { getSelection: () => ({ toString: () => 'SEL' }) })
    expect(out.selection).toBe('SEL')
  })
})

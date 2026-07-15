import { describe, it, expect } from 'vitest'
import { extractDomOutline } from './get-page-dom'

describe('extractDomOutline', () => {
  it('collects headings and interactive elements', () => {
    const doc = {
      title: 'T',
      location: { href: 'https://example.com' },
      body: {},
      querySelectorAll(selector: string) {
        if (selector.startsWith('h')) {
          return [{ textContent: 'Title' }] as Element[]
        }
        return [
          { tagName: 'BUTTON', textContent: 'Save' },
          { tagName: 'A', textContent: 'Link', getAttribute: () => 'https://example.com' },
        ] as unknown as Element[]
      },
    } as unknown as Document

    const outline = extractDomOutline(doc)
    expect(outline).toContain('Title')
    expect(outline).toContain('button: Save')
    expect(outline).toContain('a: Link')
  })
})

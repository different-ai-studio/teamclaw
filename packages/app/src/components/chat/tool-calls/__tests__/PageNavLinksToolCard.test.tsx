import { describe, expect, it, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import React from 'react'

const { navigateMock } = vi.hoisted(() => ({
  navigateMock: vi.fn(async () => undefined),
}))

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (_key: string, fallback: string) => fallback,
  }),
}))

vi.mock('@/lib/remote-tools/browser-navigate', () => ({
  navigateActiveBrowserTab: navigateMock,
}))

import { PageNavLinksToolCard } from '../PageNavLinksToolCard'

describe('PageNavLinksToolCard', () => {
  it('renders navigation buttons from tool arguments', () => {
    render(
      <PageNavLinksToolCard
        toolCall={{
          id: 'tc-1',
          name: 'show_page_nav_links',
          status: 'completed',
          arguments: {
            links: ['https://example.com/docs'],
            labels: ['文档'],
          },
        }}
      />,
    )

    const button = screen.getByRole('button', { name: /文档/ })
    expect(button).toBeTruthy()
    fireEvent.click(button)
    expect(navigateMock).toHaveBeenCalledWith('https://example.com/docs')
  })
})

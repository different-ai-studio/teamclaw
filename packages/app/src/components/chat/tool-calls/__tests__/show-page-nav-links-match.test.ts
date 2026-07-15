import { describe, expect, it } from 'vitest'

import { matchesShowPageNavLinksTool } from '@/components/chat/tool-calls/tool-call-utils'

describe('matchesShowPageNavLinksTool', () => {
  it('matches snake_case wire name', () => {
    expect(matchesShowPageNavLinksTool({ name: 'show_page_nav_links' })).toBe(true)
  })

  it('matches ACP title with spaces', () => {
    expect(matchesShowPageNavLinksTool({ name: 'show page nav links' })).toBe(true)
  })

  it('matches MCP-prefixed display titles', () => {
    expect(
      matchesShowPageNavLinksTool({ name: 'Amuxd-remote-tools show page nav links' }),
    ).toBe(true)
  })
})

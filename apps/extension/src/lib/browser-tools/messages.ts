import { isAllowedNavUrl } from './navigate'

export const BROWSER_TOOL_MSG = 'browser-tool' as const
export const BROWSER_TOOL_GET_PAGE_DOM = 'get_page_dom' as const
export const BROWSER_TOOL_SHOW_PAGE_NAV_LINKS = 'show_page_nav_links' as const
export const BROWSER_TOOL_NAVIGATE = 'navigate' as const

export type BrowserToolGetPageDomMessage = {
  type: typeof BROWSER_TOOL_MSG
  tool: typeof BROWSER_TOOL_GET_PAGE_DOM
  mode?: 'outline' | 'text'
  max_chars?: number
}

export type BrowserToolShowPageNavLinksMessage = {
  type: typeof BROWSER_TOOL_MSG
  tool: typeof BROWSER_TOOL_SHOW_PAGE_NAV_LINKS
  links: string[]
  labels?: string[]
}

export type BrowserToolNavigateMessage = {
  type: typeof BROWSER_TOOL_MSG
  tool: typeof BROWSER_TOOL_NAVIGATE
  url: string
}

export type BrowserToolMessage =
  | BrowserToolGetPageDomMessage
  | BrowserToolShowPageNavLinksMessage
  | BrowserToolNavigateMessage

export function isBrowserToolGetPageDomMessage(msg: unknown): msg is BrowserToolGetPageDomMessage {
  return (
    typeof msg === 'object' &&
    msg !== null &&
    (msg as { type?: unknown }).type === BROWSER_TOOL_MSG &&
    (msg as { tool?: unknown }).tool === BROWSER_TOOL_GET_PAGE_DOM
  )
}

export function isBrowserToolShowPageNavLinksMessage(
  msg: unknown,
): msg is BrowserToolShowPageNavLinksMessage {
  return (
    typeof msg === 'object' &&
    msg !== null &&
    (msg as { type?: unknown }).type === BROWSER_TOOL_MSG &&
    (msg as { tool?: unknown }).tool === BROWSER_TOOL_SHOW_PAGE_NAV_LINKS
  )
}

export function isBrowserToolNavigateMessage(msg: unknown): msg is BrowserToolNavigateMessage {
  return (
    typeof msg === 'object' &&
    msg !== null &&
    (msg as { type?: unknown }).type === BROWSER_TOOL_MSG &&
    (msg as { tool?: unknown }).tool === BROWSER_TOOL_NAVIGATE
  )
}

export function isBrowserToolMessage(msg: unknown): msg is BrowserToolMessage {
  return (
    isBrowserToolGetPageDomMessage(msg) ||
    isBrowserToolShowPageNavLinksMessage(msg) ||
    isBrowserToolNavigateMessage(msg)
  )
}

export type GetPageDomContentMessage = {
  type: 'get-page-dom'
  mode?: 'outline' | 'text'
  max_chars?: number
}

export type NavigateContentMessage = {
  type: 'navigate'
  url: string
}

export function isGetPageDomContentMessage(msg: unknown): msg is GetPageDomContentMessage {
  return typeof msg === 'object' && msg !== null && (msg as { type?: unknown }).type === 'get-page-dom'
}

export function isNavigateContentMessage(msg: unknown): msg is NavigateContentMessage {
  return typeof msg === 'object' && msg !== null && (msg as { type?: unknown }).type === 'navigate'
}

export function toContentGetPageDomMessage(msg: BrowserToolGetPageDomMessage): GetPageDomContentMessage {
  return {
    type: 'get-page-dom',
    mode: msg.mode,
    max_chars: msg.max_chars,
  }
}

export function toContentNavigateMessage(msg: BrowserToolNavigateMessage): NavigateContentMessage {
  return {
    type: 'navigate',
    url: msg.url,
  }
}

export function validateNavLinks(links: unknown): string[] {
  if (!Array.isArray(links) || links.length === 0) {
    throw new Error('links must be a non-empty array')
  }
  const out = links
    .filter((item): item is string => typeof item === 'string')
    .map((s) => s.trim())
    .filter(Boolean)
    .slice(0, 8)
  if (out.length === 0) {
    throw new Error('links must contain at least one non-empty string')
  }
  for (const link of out) {
    if (!isAllowedNavUrl(link)) {
      throw new Error(`unsupported link: ${link}`)
    }
  }
  return out
}

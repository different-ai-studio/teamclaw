import {
  isBrowserToolGetPageDomMessage,
  isBrowserToolNavigateMessage,
  isBrowserToolShowPageNavLinksMessage,
  toContentGetPageDomMessage,
  toContentNavigateMessage,
  validateNavLinks,
  type BrowserToolMessage,
  type BrowserToolNavigateMessage,
} from './messages'
import { isAllowedNavUrl, isSameOriginNavigation } from './navigate'

async function defaultQueryActiveTab(): Promise<{ id: number; url?: string }> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true })
  const tabId = tab?.id
  if (tabId == null) {
    throw new Error('page_not_accessible')
  }
  return { id: tabId, url: tab.url }
}

async function navigateViaContentScript(
  tabId: number,
  msg: BrowserToolNavigateMessage,
  deps: {
    injectContentScript: (tabId: number) => Promise<void>
    sendToTab: (tabId: number, payload: unknown) => Promise<unknown>
  },
): Promise<void> {
  await deps.injectContentScript(tabId)
  const resp = await deps.sendToTab(tabId, toContentNavigateMessage(msg))
  if (!resp || typeof resp !== 'object' || !(resp as { ok?: boolean }).ok) {
    throw new Error('navigation_failed')
  }
}

export async function handleBrowserToolMessage(
  msg: BrowserToolMessage,
  deps: {
    injectContentScript: (tabId: number) => Promise<void>
    sendToTab: (tabId: number, payload: unknown) => Promise<unknown>
    updateTabUrl: (tabId: number, url: string) => Promise<void>
    queryActiveTab?: () => Promise<{ id: number; url?: string }>
  },
): Promise<unknown> {
  const queryActiveTab = deps.queryActiveTab ?? defaultQueryActiveTab
  if (isBrowserToolGetPageDomMessage(msg)) {
    const tab = await queryActiveTab()
    await deps.injectContentScript(tab.id)
    const resp = await deps.sendToTab(tab.id, toContentGetPageDomMessage(msg))
    if (!resp || typeof resp !== 'object' || !('content' in resp)) {
      throw new Error('page_not_accessible')
    }
    return resp
  }

  if (isBrowserToolShowPageNavLinksMessage(msg)) {
    validateNavLinks(msg.links)
    await queryActiveTab()
    return { ok: true }
  }

  if (isBrowserToolNavigateMessage(msg)) {
    const url = msg.url.trim()
    if (!isAllowedNavUrl(url)) {
      throw new Error('unsupported url')
    }
    const tab = await queryActiveTab()
    const useContentScript =
      url.startsWith('/') ||
      url.startsWith('#') ||
      (tab.url != null && isSameOriginNavigation(tab.url, url))

    if (useContentScript) {
      await navigateViaContentScript(tab.id, msg, deps)
      return { ok: true }
    }

    await deps.updateTabUrl(tab.id, url)
    return { ok: true }
  }

  throw new Error('unknown browser tool')
}

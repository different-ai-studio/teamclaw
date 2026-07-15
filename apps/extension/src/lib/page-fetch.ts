import { isPageContext, type PageContextMsg } from './messages'

export type PageFetchDeps = {
  queryActiveTabId(): Promise<number | null>
  sendToTab(tabId: number, msg: unknown): Promise<unknown>
}

export async function fetchActivePageContext(deps: PageFetchDeps): Promise<PageContextMsg | null> {
  const tabId = await deps.queryActiveTabId()
  if (tabId == null) return null
  const resp = await deps.sendToTab(tabId, { type: 'request-page' })
  return isPageContext(resp) ? resp : null
}

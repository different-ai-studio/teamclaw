import { extractPage } from './page-extract'
import { isGetPageDomContentMessage, isNavigateContentMessage } from './browser-tools/messages'
import { buildGetPageDomResult } from './browser-tools/get-page-dom'
import { navigateInDocument, type NavigateContext } from './browser-tools/navigate'
import { isRequestPage, pageContextMsg, type PageContextMsg } from './messages'
import type { GetPageDomResult } from './browser-tools/get-page-dom'

export function handleContentMessage(
  msg: unknown,
  deps: {
    doc: Document
    navigate: NavigateContext
    getSelection(): { toString(): string } | null
  },
): PageContextMsg | GetPageDomResult | { ok: true } | null {
  if (isGetPageDomContentMessage(msg)) {
    return buildGetPageDomResult(deps.doc, msg)
  }
  if (isNavigateContentMessage(msg)) {
    navigateInDocument(deps.navigate, msg.url)
    return { ok: true }
  }
  if (!isRequestPage(msg)) return null
  return pageContextMsg(extractPage(deps.doc, { getSelection: deps.getSelection }))
}

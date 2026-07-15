import type { ExtractedPage } from './page-extract'
import {
  isPendingLinkOpenPayload,
  PENDING_LINK_OPEN_KEY,
  type PendingLinkOpen,
} from '@teamclaw/extension-link-session'

export type { PendingLinkOpen }
export { PENDING_LINK_OPEN_KEY, isPendingLinkOpenPayload }

export type RequestPageMsg = { type: 'request-page' }
export type PageContextMsg = { type: 'page-context'; payload: ExtractedPage }

export type OpenSidePanelMsg = { type: 'open-side-panel'; payload: PendingLinkOpen }

export const PENDING_LINK_CONTEXT_KEY = 'teamclaw.pendingLinkContext'

export function isRequestPage(m: unknown): m is RequestPageMsg {
  return typeof m === 'object' && m !== null && (m as { type?: unknown }).type === 'request-page'
}

export function isOpenSidePanel(m: unknown): m is OpenSidePanelMsg {
  return (
    typeof m === 'object' && m !== null &&
    (m as { type?: unknown }).type === 'open-side-panel' &&
    isPendingLinkOpenPayload((m as { payload?: unknown }).payload)
  )
}

export function isPageContext(m: unknown): m is PageContextMsg {
  return (
    typeof m === 'object' && m !== null &&
    (m as { type?: unknown }).type === 'page-context' &&
    typeof (m as { payload?: unknown }).payload === 'object' &&
    (m as { payload?: unknown }).payload !== null
  )
}

export function pageContextMsg(payload: ExtractedPage): PageContextMsg {
  return { type: 'page-context', payload }
}

export function openSidePanelMsg(payload: PendingLinkOpen): OpenSidePanelMsg {
  return { type: 'open-side-panel', payload }
}

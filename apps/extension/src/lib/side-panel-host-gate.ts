/**
 * Publish active-tab host-gate state for the domain-gated side panel.
 * No-op when extensions.domains is empty (ungated builds).
 *
 * Keeps the panel window-scoped (never binds tabId). Non-allowed tabs get an
 * in-panel overlay via storage / runtime message — we do not disable/close the
 * panel (Chrome requires a user gesture to reopen).
 */
import {
  isUrlAllowedBySidePanelPatterns,
  parseSidePanelDomainPatterns,
  SIDE_PANEL_HOST_GATE_STORAGE_KEY,
  type SidePanelHostGateSnapshot,
} from '@teamclaw/side-panel-host-allowlist'

declare const __SIDE_PANEL_DOMAINS__: string

export const SIDE_PANEL_HOST_GATE_MSG = 'side-panel-host-gate' as const

const patterns = parseSidePanelDomainPatterns(
  typeof __SIDE_PANEL_DOMAINS__ === 'string' ? __SIDE_PANEL_DOMAINS__ : '',
)

export function isSidePanelHostGateBuildEnabled(): boolean {
  return patterns.length > 0
}

async function writeGateSnapshot(snapshot: SidePanelHostGateSnapshot): Promise<void> {
  try {
    await chrome.storage.session.set({ [SIDE_PANEL_HOST_GATE_STORAGE_KEY]: snapshot })
  } catch (e) {
    console.warn('[bg] side-panel host gate storage failed', e)
  }
  try {
    await chrome.runtime.sendMessage({ type: SIDE_PANEL_HOST_GATE_MSG, ...snapshot })
  } catch {
    // No sidepanel listeners yet — storage remains the source of truth.
  }
}

async function evaluateActiveTab(windowId?: number): Promise<void> {
  if (!isSidePanelHostGateBuildEnabled()) return
  try {
    const query =
      windowId != null
        ? { active: true, windowId }
        : { active: true, lastFocusedWindow: true }
    const [tab] = await chrome.tabs.query(query)
    const url = tab?.url ?? null
    const allowed = isUrlAllowedBySidePanelPatterns(url, patterns)
    await writeGateSnapshot({ allowed, url })
  } catch (e) {
    console.warn('[bg] side-panel host gate evaluate failed', e)
  }
}

export function startSidePanelHostGate(): void {
  if (!isSidePanelHostGateBuildEnabled()) return

  void evaluateActiveTab()

  chrome.tabs.onActivated.addListener((info) => {
    void evaluateActiveTab(info.windowId)
  })

  chrome.tabs.onUpdated.addListener((_tabId, changeInfo, tab) => {
    if (!tab.active) return
    if (changeInfo.url == null && changeInfo.status !== 'complete') return
    void evaluateActiveTab(tab.windowId)
  })

  chrome.windows.onFocusChanged.addListener((windowId) => {
    if (windowId === chrome.windows.WINDOW_ID_NONE) return
    void evaluateActiveTab(windowId)
  })
}

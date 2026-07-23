import { fetchActivePageContext } from './lib/page-fetch'
import { isOpenSidePanel, isRequestPage } from './lib/messages'
import { isBrowserToolMessage } from './lib/browser-tools/messages'
import { handleBrowserToolMessage } from './lib/browser-tools/handle-browser-tool'
import { openSidePanelFromUserGesture } from './lib/open-side-panel'
import { startSidePanelHostGate } from './lib/side-panel-host-gate'

const SIDE_PANEL_PATH = 'sidepanel/index.html'

/**
 * Hosts the extension is scoped to, read from the (brand-injected) manifest so
 * this stays in sync with host_permissions without hardcoding any brand's
 * domains. Falls back to all http/https for a non-branded build.
 */
const SCOPED_TAB_URLS =
  chrome.runtime.getManifest().host_permissions?.length
    ? chrome.runtime.getManifest().host_permissions!
    : ['http://*/*', 'https://*/*']

chrome.sidePanel
  .setPanelBehavior({ openPanelOnActionClick: true })
  .catch((e) => console.warn('[bg] setPanelBehavior failed', e))

/**
 * Global (window-scoped) panel only.
 * Never call setOptions({ tabId, path }) — Chrome treats that as a *second*
 * sidepanel/index.html instance when path matches side_panel.default_path.
 */
async function ensureGlobalSidePanel(): Promise<void> {
  try {
    await chrome.sidePanel.setOptions({
      path: SIDE_PANEL_PATH,
      enabled: true,
    })
  } catch (e) {
    console.warn('[bg] ensureGlobalSidePanel failed', e)
  }
}

async function injectContentScript(tabId: number): Promise<void> {
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ['content-script.js'],
    })
  } catch (e) {
    console.warn('[bg] inject content-script failed', tabId, e)
  }
}

/** Content scripts in manifest only attach on navigation — backfill open tabs. */
async function injectOpenHttpTabs(): Promise<void> {
  const tabs = await chrome.tabs.query({ url: SCOPED_TAB_URLS })
  await Promise.all(
    tabs.map(async (tab) => {
      if (!tab.id) return
      await injectContentScript(tab.id)
    }),
  )
}

async function bootstrapSidePanel(): Promise<void> {
  await ensureGlobalSidePanel()
  await injectOpenHttpTabs()
}

chrome.runtime.onInstalled.addListener(() => {
  void bootstrapSidePanel()
})

chrome.runtime.onStartup.addListener(() => {
  void bootstrapSidePanel()
})

// Domain-gated builds: publish active-tab allow state (overlay in panel, no close).
startSidePanelHostGate()

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (isOpenSidePanel(msg)) {
    const windowId = sender.tab?.windowId
    if (windowId == null) {
      sendResponse({ ok: false, error: 'no-window' })
      return true
    }

    void openSidePanelFromUserGesture(msg, windowId).then(sendResponse)
    return true
  }

  if (isBrowserToolMessage(msg)) {
    void (async () => {
      try {
        const result = await handleBrowserToolMessage(msg, {
          injectContentScript,
          sendToTab: async (tabId, payload) => {
            await injectContentScript(tabId)
            return chrome.tabs.sendMessage(tabId, payload)
          },
          updateTabUrl: async (tabId, url) => {
            await chrome.tabs.update(tabId, { url })
          },
        })
        sendResponse(result)
      } catch (e) {
        sendResponse({ error: e instanceof Error ? e.message : String(e) })
      }
    })()
    return true
  }

  if (!isRequestPage(msg)) return undefined

  void (async () => {
    const ctx = await fetchActivePageContext({
      queryActiveTabId: async () => {
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true })
        return tab?.id ?? null
      },
      sendToTab: async (tabId, m) => {
        await injectContentScript(tabId)
        return chrome.tabs.sendMessage(tabId, m)
      },
    })
    sendResponse(ctx ?? { type: 'page-context', error: 'unavailable' })
  })()
  return true
})

import { fetchActivePageContext } from './lib/page-fetch'
import { isOpenSidePanel, isRequestPage } from './lib/messages'
import { isBrowserToolMessage } from './lib/browser-tools/messages'
import { handleBrowserToolMessage } from './lib/browser-tools/handle-browser-tool'
import { openSidePanelFromUserGesture } from './lib/open-side-panel'

const SIDE_PANEL_PATH = 'sidepanel/index.html'

chrome.sidePanel
  .setPanelBehavior({ openPanelOnActionClick: true })
  .catch((e) => console.warn('[bg] setPanelBehavior failed', e))

async function enableSidePanelForTab(tabId: number): Promise<void> {
  await chrome.sidePanel.setOptions({
    tabId,
    path: SIDE_PANEL_PATH,
    enabled: true,
  })
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
  const tabs = await chrome.tabs.query({ url: ['http://*/*', 'https://*/*'] })
  await Promise.all(
    tabs.map(async (tab) => {
      if (!tab.id) return
      await enableSidePanelForTab(tab.id)
      await injectContentScript(tab.id)
    }),
  )
}

chrome.runtime.onInstalled.addListener(() => {
  void injectOpenHttpTabs()
})

chrome.runtime.onStartup.addListener(() => {
  void injectOpenHttpTabs()
})

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (isOpenSidePanel(msg)) {
    const tabId = sender.tab?.id
    if (!tabId) {
      sendResponse({ ok: false, error: 'no-tab' })
      return true
    }

    void openSidePanelFromUserGesture(msg, tabId, sender.tab?.windowId).then(sendResponse)
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

import { PENDING_LINK_OPEN_KEY, type OpenSidePanelMsg } from './messages'

const SIDE_PANEL_PATH = 'sidepanel/index.html'

export type OpenSidePanelResult = { ok: true } | { ok: false; error: string }

/**
 * Open the **global** (window-scoped) side panel in the same synchronous turn
 * as the user click.
 *
 * Important: do NOT pass `tabId` to `sidePanel.open` / `setOptions`. Chrome
 * treats `setOptions({ tabId, path })` with the same path as
 * `side_panel.default_path` as a *separate* panel instance. Multiple
 * `sidepanel/index.html` pages then run in parallel (separate React trees,
 * shared chrome.storage) and corrupt session/message state.
 *
 * `chrome.sidePanel.open()` requires a live user gesture — any await before it
 * in the service worker causes a silent no-op. The content-script stashes
 * PENDING_LINK_OPEN_KEY before messaging here; we stash again after open as backup.
 */
export function openSidePanelFromUserGesture(
  msg: OpenSidePanelMsg,
  windowId: number,
): Promise<OpenSidePanelResult> {
  return new Promise((resolve) => {
    const openOpts: chrome.sidePanel.OpenOptions = { windowId }

    const stashPayload = () => {
      void chrome.storage.session.set({ [PENDING_LINK_OPEN_KEY]: msg.payload })
    }

    const finish = (ok: boolean, error?: string) => {
      if (ok) stashPayload()
      resolve(ok ? { ok: true } : { ok: false, error: error ?? 'open failed' })
    }

    chrome.sidePanel.open(openOpts, () => {
      const openErr = chrome.runtime.lastError
      if (!openErr) {
        finish(true)
        return
      }

      // Global options only — never tabId (would spawn a second instance).
      chrome.sidePanel.setOptions(
        { path: SIDE_PANEL_PATH, enabled: true },
        () => {
          const setErr = chrome.runtime.lastError
          if (setErr) {
            finish(false, setErr.message)
            return
          }
          chrome.sidePanel.open(openOpts, () => {
            const retryErr = chrome.runtime.lastError
            finish(!retryErr, retryErr?.message)
          })
        },
      )
    })
  })
}

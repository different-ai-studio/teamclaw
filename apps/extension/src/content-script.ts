import { handleContentMessage } from './lib/content-handler'
import { mountLinkHover, type LinkHoverMount } from './lib/link-hover'
import { openSidePanelMsg, PENDING_LINK_OPEN_KEY } from './lib/messages'
import { extractPage } from './lib/page-extract'
import { normalizeLinkKey } from '@teamclaw/extension-link-session'
import {
  isLinkHoverEnabledForHost,
  isLinkUrlAllowed,
  readLinkHoverConfig,
  watchLinkHoverConfig,
  type LinkHoverConfig,
} from '@teamclaw/extension-link-hover'

const GUARD_KEY = '__teamclawContentScriptLoaded' as const
type GuardedWindow = Window & { [GUARD_KEY]?: boolean }

function buildPendingLinkOpen(link: HTMLAnchorElement, doc: Document, win: Window) {
  const page = extractPage(doc, win)
  const linkUrl = link.href
  const linkText = (link.textContent ?? '').replace(/\s+/g, ' ').trim()
  page.url = linkUrl
  if (linkText) {
    page.selection = linkText
  }
  const linkKey = normalizeLinkKey(linkUrl)
  return {
    page,
    linkKey,
    linkUrl,
    linkText,
    source: 'link-hover' as const,
  }
}

function boot() {
  const w = window as GuardedWindow
  if (w[GUARD_KEY]) return
  w[GUARD_KEY] = true

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    const out = handleContentMessage(msg, {
      doc: document,
      navigate: {
        location: window.location,
        history: window.history,
        dispatchPopState: () => {
          window.dispatchEvent(new PopStateEvent('popstate', { state: window.history.state }))
        },
      },
      getSelection: () => window.getSelection(),
    })
    if (out) {
      sendResponse(out)
      return true
    }
    return undefined
  })

  let hoverMount: LinkHoverMount | null = null
  let urlPatterns: string[] = []

  const syncHoverMount = (config: LinkHoverConfig) => {
    urlPatterns = config.urlPatterns
    const enabled = isLinkHoverEnabledForHost(window.location.hostname, config)
    if (enabled && !hoverMount) {
      hoverMount = mountLinkHover({
        doc: document,
        win: window,
        matchesLinkUrl: (url) => isLinkUrlAllowed(url, urlPatterns),
        onOpen(link) {
          const payload = buildPendingLinkOpen(link, document, window)
          // Stash in the click turn before the service worker opens the panel so a
          // cold-started sidepanel can read the payload on first mount (background
          // stashes again after open as a backup).
          void chrome.storage.session.set({ [PENDING_LINK_OPEN_KEY]: payload })
          chrome.runtime.sendMessage(openSidePanelMsg(payload), (resp) => {
            const err = chrome.runtime.lastError
            if (err) {
              console.warn('[teamclaw] open side panel failed:', err.message)
              return
            }
            if (resp && typeof resp === 'object' && 'ok' in resp && !(resp as { ok: boolean }).ok) {
              console.warn('[teamclaw] open side panel rejected:', resp)
            }
          })
        },
      })
      return
    }

    if (!enabled && hoverMount) {
      hoverMount.destroy()
      hoverMount = null
    }
  }

  void (async () => {
    const initial = await readLinkHoverConfig()
    syncHoverMount(initial)
    watchLinkHoverConfig(syncHoverMount)
  })()
}

boot()

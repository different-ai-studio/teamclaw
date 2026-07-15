import { detectDarkContext } from './link-hover-theme'
import { isLinkHoverTargetVisible, isPointerInHoverKeepZone } from './link-hover-zone'

const HIDE_DELAY_MS = 220
const BTN_WIDTH = 106
const BTN_HEIGHT = 28
const GAP = 8

/** http(s) navigational anchors only — skip mailto, javascript:, hash-only, etc. */
export function isActionableLink(el: Element | null): el is HTMLAnchorElement {
  if (!el || el.localName?.toLowerCase() !== 'a') return false
  const anchor = el as HTMLAnchorElement
  const hrefAttr = anchor.getAttribute('href')?.trim() || anchor.href || ''
  if (!hrefAttr || hrefAttr.startsWith('#')) return false
  try {
    const url = /^https?:\/\//i.test(hrefAttr)
      ? new URL(hrefAttr)
      : new URL(hrefAttr, typeof document !== 'undefined' ? document.baseURI : 'https://example.invalid/')
    return url.protocol === 'http:' || url.protocol === 'https:'
  } catch {
    return false
  }
}

export function findActionableLinkFromTarget(target: EventTarget | null): HTMLAnchorElement | null {
  if (!target || typeof (target as Element).closest !== 'function') return null
  const link = (target as Element).closest('a')
  return isActionableLink(link) ? link : null
}

export type LinkHoverMount = {
  showFor(link: HTMLAnchorElement): void
  hide(): void
  destroy(): void
}

export function mountLinkHover(deps: {
  doc: Document
  win: Window
  onOpen: (link: HTMLAnchorElement) => void
}): LinkHoverMount {
  const { doc, win, onOpen } = deps

  const host = doc.createElement('div')
  host.id = 'teamclaw-link-hover-host'
  host.style.cssText = [
    'position:fixed',
    'z-index:2147483647',
    'pointer-events:none',
    'display:none',
    'left:0',
    'top:0',
  ].join(';')
  const shadow = host.attachShadow({ mode: 'closed' })

  const style = doc.createElement('style')
  style.textContent = `
    .wrap { pointer-events: auto; display: inline-flex; }
    .btn {
      all: initial;
      font-family: "PingFang SC", "Noto Sans SC", system-ui, sans-serif;
      font-size: 11px;
      font-weight: 500;
      line-height: 1;
      display: inline-flex;
      align-items: center;
      gap: 6px;
      padding: 5px 10px;
      border-radius: 999px;
      border: 1px solid rgba(26, 26, 20, 0.14);
      background: #ffffff;
      color: #3d3c34;
      cursor: pointer;
      box-shadow: 0 2px 8px rgba(20, 20, 15, 0.1);
      white-space: nowrap;
    }
    .btn:hover {
      border-color: rgba(26, 26, 20, 0.22);
      box-shadow: 0 4px 12px rgba(20, 20, 15, 0.14);
    }
    .ai-pill {
      font-family: "JetBrains Mono", "SF Mono", ui-monospace, monospace;
      font-size: 9px;
      font-weight: 600;
      padding: 1px 4px;
      border-radius: 3px;
      border: 1px solid #e85a4a;
      color: #e85a4a;
      line-height: 1.2;
      flex-shrink: 0;
    }
    .wrap.on-dark .ai-pill {
      border-color: rgba(252, 168, 158, 0.85);
      color: #fca89e;
    }
    .wrap.on-dark .btn {
      border-color: rgba(255, 255, 255, 0.16);
      background: #1e293b;
      color: #e2e8f0;
      box-shadow: 0 4px 14px rgba(0, 0, 0, 0.35);
    }
    .wrap.on-dark .btn:hover {
      background: #243044;
      border-color: rgba(255, 255, 255, 0.22);
      box-shadow: 0 6px 18px rgba(0, 0, 0, 0.4);
    }
  `

  const wrap = doc.createElement('div')
  wrap.className = 'wrap'

  const btn = doc.createElement('button')
  btn.type = 'button'
  btn.className = 'btn'
  btn.title = '用 TeamClaw 问 Agent'
  const aiPill = doc.createElement('span')
  aiPill.className = 'ai-pill'
  aiPill.textContent = 'AI'
  btn.appendChild(aiPill)
  btn.appendChild(doc.createTextNode('TeamClaw'))

  wrap.appendChild(btn)
  shadow.append(style, wrap)

  const mountTarget = doc.body ?? doc.documentElement
  mountTarget.appendChild(host)

  let activeLink: HTMLAnchorElement | null = null
  let hideTimer: ReturnType<typeof win.setTimeout> | null = null
  let moveRaf = 0
  let lastPointerX = 0
  let lastPointerY = 0
  let syncRaf = 0

  function readLinkVisibility(el: Element) {
    const style = win.getComputedStyle(el)
    return {
      isConnected: el.isConnected,
      rect: el.getBoundingClientRect(),
      display: style.display,
      visibility: style.visibility,
      opacity: style.opacity,
    }
  }

  function stopSyncLoop() {
    if (syncRaf) {
      win.cancelAnimationFrame(syncRaf)
      syncRaf = 0
    }
  }

  function syncActiveAffordance() {
    if (!activeLink || host.style.display === 'none') return
    if (!isLinkHoverTargetVisible(activeLink, readLinkVisibility)) {
      hide()
      return
    }
    positionFor(activeLink)
  }

  function startSyncLoop() {
    if (syncRaf) return
    const tick = () => {
      syncRaf = win.requestAnimationFrame(tick)
      syncActiveAffordance()
      if (!activeLink || host.style.display === 'none') stopSyncLoop()
    }
    syncRaf = win.requestAnimationFrame(tick)
  }

  function clearHideTimer() {
    if (hideTimer !== null) {
      win.clearTimeout(hideTimer)
      hideTimer = null
    }
  }

  function isOverAffordanceHost(target: EventTarget | null): boolean {
    return target === host || (target instanceof Node && host.contains(target))
  }

  function isPointerInActiveKeepZone(x: number, y: number): boolean {
    if (!activeLink || host.style.display === 'none') return false
    return isPointerInHoverKeepZone(
      x,
      y,
      activeLink.getBoundingClientRect(),
      host.getBoundingClientRect(),
    )
  }

  function positionFor(link: HTMLAnchorElement) {
    const rect = link.getBoundingClientRect()
    if (rect.width === 0 && rect.height === 0) return

    const onDark = detectDarkContext(link, (node) => win.getComputedStyle(node).backgroundColor)
    wrap.classList.toggle('on-dark', onDark)

    let left = rect.right + GAP
    const top = Math.max(8, rect.top + (rect.height - BTN_HEIGHT) / 2)
    if (left + BTN_WIDTH > win.innerWidth - 8) {
      left = rect.left - BTN_WIDTH - GAP
    }
    host.style.left = `${Math.max(8, left)}px`
    host.style.top = `${top}px`
  }

  function showFor(link: HTMLAnchorElement) {
    clearHideTimer()
    activeLink = link
    positionFor(link)
    host.style.display = 'block'
    startSyncLoop()
  }

  function hide() {
    clearHideTimer()
    stopSyncLoop()
    activeLink = null
    host.style.display = 'none'
  }

  function scheduleHide() {
    clearHideTimer()
    hideTimer = win.setTimeout(() => {
      hideTimer = null
      if (isPointerInActiveKeepZone(lastPointerX, lastPointerY)) return
      hide()
    }, HIDE_DELAY_MS)
  }

  function linkAtPoint(x: number, y: number): HTMLAnchorElement | null {
    if (typeof doc.elementFromPoint !== 'function') return null
    const stack = doc.elementsFromPoint?.(x, y) ?? [doc.elementFromPoint(x, y)].filter(Boolean)
    for (const el of stack) {
      if (!(el instanceof Element)) continue
      if (host === el || host.contains(el) || shadow.contains(el)) continue
      const link = el.closest('a')
      if (isActionableLink(link)) return link
    }
    return null
  }

  function onPointerMove(e: PointerEvent) {
    lastPointerX = e.clientX
    lastPointerY = e.clientY
    if (moveRaf) win.cancelAnimationFrame(moveRaf)
    moveRaf = win.requestAnimationFrame(() => {
      moveRaf = 0
      if (isOverAffordanceHost(e.target) || isPointerInActiveKeepZone(e.clientX, e.clientY)) {
        clearHideTimer()
        return
      }
      const link =
        findActionableLinkFromTarget(e.target) ??
        linkAtPoint(e.clientX, e.clientY)
      if (link) {
        showFor(link)
        return
      }
      scheduleHide()
    })
  }

  function onScrollOrResize() {
    syncActiveAffordance()
  }

  function onPointerDown(e: PointerEvent) {
    if (host.style.display === 'none') return
    if (isOverAffordanceHost(e.target)) return
    if (isPointerInActiveKeepZone(e.clientX, e.clientY)) return
    hide()
  }

  function onVisibilityChange() {
    if (doc.visibilityState === 'hidden') hide()
  }

  btn.addEventListener('pointerdown', (e) => {
    e.preventDefault()
    e.stopPropagation()
    if (!activeLink) return
    onOpen(activeLink)
    hide()
  })

  wrap.addEventListener('pointerenter', clearHideTimer)
  wrap.addEventListener('pointerleave', scheduleHide)
  doc.addEventListener('pointermove', onPointerMove, true)
  doc.addEventListener('pointerdown', onPointerDown, true)
  doc.addEventListener('visibilitychange', onVisibilityChange)
  win.addEventListener('scroll', onScrollOrResize, true)
  win.addEventListener('resize', onScrollOrResize)

  return {
    showFor,
    hide,
    destroy() {
      clearHideTimer()
      stopSyncLoop()
      if (moveRaf) win.cancelAnimationFrame(moveRaf)
      doc.removeEventListener('pointermove', onPointerMove, true)
      doc.removeEventListener('pointerdown', onPointerDown, true)
      doc.removeEventListener('visibilitychange', onVisibilityChange)
      win.removeEventListener('scroll', onScrollOrResize, true)
      win.removeEventListener('resize', onScrollOrResize)
      host.remove()
    },
  }
}

/**
 * The four edges the corridor math actually reads. Declaring the full
 * DOMRectReadOnly would also demand x/y/toJSON, which nothing here touches and
 * which a caller (or a test) would have to fabricate. A real DOMRect still
 * satisfies this.
 */
export type RectEdges = Pick<DOMRectReadOnly, 'left' | 'right' | 'top' | 'bottom'>

/** Link + gap + affordance button — keeps hover open while crossing the bridge. */
export function isPointerInHoverKeepZone(
  x: number,
  y: number,
  linkRect: RectEdges,
  hostRect: RectEdges,
  padding = 6,
): boolean {
  const inPadded = (r: RectEdges) =>
    x >= r.left - padding && x <= r.right + padding && y >= r.top - padding && y <= r.bottom + padding

  if (inPadded(linkRect) || inPadded(hostRect)) return true

  const gapLeft = Math.min(linkRect.right, hostRect.right)
  const gapRight = Math.max(linkRect.left, hostRect.left)
  if (gapRight <= gapLeft) return false

  const bridgeTop = Math.min(linkRect.top, hostRect.top) - padding
  const bridgeBottom = Math.max(linkRect.bottom, hostRect.bottom) + padding
  return x >= gapLeft - padding && x <= gapRight + padding && y >= bridgeTop && y <= bridgeBottom
}

export type ElementVisibilityProbe = {
  isConnected: boolean
  /** Only the extent is read — a collapsed box means the link is not hoverable. */
  rect: Pick<DOMRectReadOnly, 'width' | 'height'>
  display: string
  visibility: string
  opacity: string
}

/** False when the anchor is detached, collapsed, or hidden by an ancestor. */
export function isLinkHoverTargetVisible(
  link: Element,
  read: (el: Element) => ElementVisibilityProbe,
): boolean {
  const self = read(link)
  if (!self.isConnected) return false
  if (self.rect.width === 0 || self.rect.height === 0) return false

  let el: Element | null = link
  while (el) {
    const style = read(el)
    if (style.display === 'none' || style.visibility === 'hidden') return false
    const opacity = Number.parseFloat(style.opacity)
    if (!Number.isNaN(opacity) && opacity === 0) return false
    el = el.parentElement
  }
  return true
}

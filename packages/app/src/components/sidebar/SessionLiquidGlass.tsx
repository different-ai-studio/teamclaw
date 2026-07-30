import * as React from 'react'
import { cn } from '@/lib/utils'

/** Matches SessionListColumn C2 dock grid transition + virtualizer remeasure delay. */
const ROW_LAYOUT_SETTLE_MS = 280

type SessionLiquidGlassProps = {
  /** Positioning root that wraps the session rows (must be `position: relative`). */
  rootRef: React.RefObject<HTMLElement | null>
  /** Scroll parent — used to remeasure on scroll (virtual list). */
  scrollRef: React.RefObject<HTMLElement | null>
  activeSessionId: string | null | undefined
  /** Hide during batch select / empty states. */
  disabled?: boolean
  /** Extra deps that change row geometry (dock open, row set, etc.). */
  layoutKey?: string | number
}

/**
 * Shared Soft Comfort “liquid glass” selection pill.
 * One layer slides via translateY/height instead of per-card paper shadows.
 */
export function SessionLiquidGlass({
  rootRef,
  scrollRef,
  activeSessionId,
  disabled = false,
  layoutKey,
}: SessionLiquidGlassProps) {
  const glassRef = React.useRef<HTMLDivElement>(null)
  const [visible, setVisible] = React.useState(false)
  const [moving, setMoving] = React.useState(false)
  const prevIdRef = React.useRef<string | null | undefined>(null)
  const moveTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null)
  const layoutSettleTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null)

  const syncFrameRef = React.useRef<number | null>(null)

  const measureAndApply = React.useCallback(() => {
    const root = rootRef.current
    const glass = glassRef.current
    if (!root || !glass || disabled || !activeSessionId) {
      setVisible(false)
      return
    }

    const row = Array.from(
      root.querySelectorAll<HTMLElement>('[data-testid="v2-session-row"]'),
    ).find((el) => el.getAttribute('data-session-id') === activeSessionId)
    if (!row) {
      setVisible(false)
      return
    }

    const rootRect = root.getBoundingClientRect()
    const rowRect = row.getBoundingClientRect()
    const top = rowRect.top - rootRect.top
    const height = rowRect.height

    glass.style.transform = `translate3d(0, ${Math.max(0, top)}px, 0)`
    glass.style.height = `${Math.max(0, height)}px`
    setVisible(true)
  }, [rootRef, activeSessionId, disabled])

  /** Coalesce scroll/resize/observer bursts into one measure per frame. */
  const sync = React.useCallback(() => {
    if (syncFrameRef.current != null) {
      cancelAnimationFrame(syncFrameRef.current)
    }
    syncFrameRef.current = requestAnimationFrame(() => {
      syncFrameRef.current = null
      measureAndApply()
    })
  }, [measureAndApply])

  React.useLayoutEffect(() => {
    const idChanged = prevIdRef.current !== activeSessionId
    if (idChanged && activeSessionId && prevIdRef.current != null && prevIdRef.current !== undefined) {
      setMoving(true)
      if (moveTimerRef.current) clearTimeout(moveTimerRef.current)
      moveTimerRef.current = setTimeout(() => setMoving(false), 420)
    }
    prevIdRef.current = activeSessionId ?? null
    // Synchronous — avoid one frame of stale geometry after list re-order.
    measureAndApply()
  }, [measureAndApply, activeSessionId, layoutKey, disabled])

  React.useEffect(() => {
    const scroll = scrollRef.current
    if (!scroll) return
    const onScroll = () => sync()
    scroll.addEventListener('scroll', onScroll, { passive: true })
    window.addEventListener('resize', sync)
    return () => {
      scroll.removeEventListener('scroll', onScroll)
      window.removeEventListener('resize', sync)
    }
  }, [scrollRef, sync])

  React.useEffect(() => {
    if (disabled || !activeSessionId) return
    sync()
    if (layoutSettleTimerRef.current) clearTimeout(layoutSettleTimerRef.current)
    layoutSettleTimerRef.current = setTimeout(() => {
      layoutSettleTimerRef.current = null
      sync()
    }, ROW_LAYOUT_SETTLE_MS)
    return () => {
      if (layoutSettleTimerRef.current) {
        clearTimeout(layoutSettleTimerRef.current)
        layoutSettleTimerRef.current = null
      }
    }
  }, [activeSessionId, disabled, layoutKey, sync])

  React.useEffect(() => {
    const root = rootRef.current
    if (!root || !activeSessionId || disabled) return
    if (typeof ResizeObserver === 'undefined') return

    const rows = root.querySelectorAll<HTMLElement>('[data-testid="v2-session-row"]')
    if (rows.length === 0) return

    const ro = new ResizeObserver(() => sync())
    rows.forEach((row) => ro.observe(row))
    return () => ro.disconnect()
  }, [rootRef, activeSessionId, disabled, layoutKey, sync])

  React.useEffect(() => () => {
    if (moveTimerRef.current) clearTimeout(moveTimerRef.current)
    if (layoutSettleTimerRef.current) clearTimeout(layoutSettleTimerRef.current)
    if (syncFrameRef.current != null) cancelAnimationFrame(syncFrameRef.current)
  }, [])

  return (
    <div
      ref={glassRef}
      aria-hidden
      data-testid="v2-session-liquid-glass"
      data-visible={visible ? 'true' : 'false'}
      data-moving={moving ? 'true' : 'false'}
      className={cn('session-liquid-glass', moving && 'session-liquid-glass--moving')}
      style={{ opacity: visible ? 1 : 0 }}
    />
  )
}

import { useEffect, useState } from 'react'

export type LayoutBreakpoint = 'wide' | 'medium' | 'narrow'

const WIDE_MIN_WIDTH = 1024
const SESSION_LIST_MIN_WIDTH = 900

export function getLayoutBreakpointForWidth(width: number): LayoutBreakpoint {
  if (width >= WIDE_MIN_WIDTH) return 'wide'
  if (width >= SESSION_LIST_MIN_WIDTH) return 'medium'
  return 'narrow'
}

function get(): LayoutBreakpoint {
  const w = typeof window !== 'undefined' ? window.innerWidth : 1280
  return getLayoutBreakpointForWidth(w)
}

export function useLayoutBreakpoint(): LayoutBreakpoint {
  const [bp, setBp] = useState<LayoutBreakpoint>(get)
  useEffect(() => {
    const handler = () => setBp(get())
    window.addEventListener('resize', handler)
    return () => window.removeEventListener('resize', handler)
  }, [])
  return bp
}

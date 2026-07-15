export function isAllowedNavUrl(raw: string): boolean {
  const trimmed = raw.trim()
  if (!trimmed) return false
  if (trimmed.startsWith('/') || trimmed.startsWith('#')) return true
  try {
    const u = new URL(trimmed)
    return u.protocol === 'http:' || u.protocol === 'https:'
  } catch {
    return false
  }
}

export function resolveNavigationTarget(current: Location, raw: string): URL {
  const trimmed = raw.trim()
  if (trimmed.startsWith('#')) {
    return new URL(`${current.pathname}${current.search}${trimmed}`, current.origin)
  }
  if (trimmed.startsWith('/')) {
    return new URL(trimmed, current.origin)
  }
  return new URL(trimmed)
}

export function isSameOriginNavigation(currentHref: string, targetRaw: string): boolean {
  try {
    const current = new URL(currentHref)
    const target = resolveNavigationTarget(current as unknown as Location, targetRaw)
    return target.origin === current.origin
  } catch {
    return false
  }
}

export type NavigateContext = {
  location: Location
  history: Pick<History, 'pushState' | 'state'>
  dispatchPopState: () => void
}

export function navigateInDocument(ctx: NavigateContext, url: string): void {
  const trimmed = url.trim()
  if (!trimmed) {
    throw new Error('url required')
  }
  if (!isAllowedNavUrl(trimmed)) {
    throw new Error('unsupported url')
  }

  const target = resolveNavigationTarget(ctx.location, trimmed)

  if (trimmed.startsWith('#')) {
    const nextHash = target.hash || trimmed
    if (ctx.location.hash !== nextHash) {
      ctx.location.hash = nextHash
    }
    return
  }

  if (target.origin === ctx.location.origin) {
    const next = target.pathname + target.search + target.hash
    const current = ctx.location.pathname + ctx.location.search + ctx.location.hash
    if (next !== current) {
      ctx.history.pushState(ctx.history.state, '', next)
      ctx.dispatchPopState()
    }
    return
  }

  ctx.location.assign(target.href)
}

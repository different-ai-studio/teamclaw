/** chrome.storage.local key for link-hover domain allowlist. */
export const LINK_HOVER_CONFIG_KEY = 'teamclaw.extension.linkHover'

export interface LinkHoverConfig {
  domains: string[]
}

export const DEFAULT_LINK_HOVER_CONFIG: LinkHoverConfig = {
  domains: [],
}

const DOMAIN_LABEL =
  /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/i

/** Normalize user input to a hostname label (no protocol, path, or port). */
export function normalizeDomainEntry(raw: string): string | null {
  let value = raw.trim().toLowerCase()
  if (!value) return null

  value = value.replace(/^https?:\/\//, '')
  value = value.split('/')[0]?.split('?')[0]?.split('#')[0] ?? ''
  value = value.split(':')[0] ?? ''
  value = value.replace(/\.$/, '')
  if (value.startsWith('www.')) {
    value = value.slice(4)
  }

  if (!value || !value.includes('.') || !DOMAIN_LABEL.test(value)) return null
  return value
}

export function isHostAllowed(hostname: string, domains: readonly string[]): boolean {
  if (domains.length === 0) return false

  const host = hostname.trim().toLowerCase().replace(/\.$/, '')
  if (!host) return false

  for (const entry of domains) {
    const pattern = typeof entry === 'string' ? entry.trim().toLowerCase() : ''
    if (!pattern) continue
    if (host === pattern) return true
    if (host.endsWith(`.${pattern}`)) return true
  }
  return false
}

export function parseLinkHoverConfig(raw: unknown): LinkHoverConfig {
  if (!raw || typeof raw !== 'object') {
    return { ...DEFAULT_LINK_HOVER_CONFIG }
  }

  const domainsRaw = (raw as { domains?: unknown }).domains
  if (!Array.isArray(domainsRaw)) {
    return { ...DEFAULT_LINK_HOVER_CONFIG }
  }

  const seen = new Set<string>()
  const domains: string[] = []
  for (const item of domainsRaw) {
    if (typeof item !== 'string') continue
    const normalized = normalizeDomainEntry(item)
    if (!normalized || seen.has(normalized)) continue
    seen.add(normalized)
    domains.push(normalized)
  }

  return { domains }
}

export function isLinkHoverEnabledForHost(
  hostname: string,
  config: LinkHoverConfig,
): boolean {
  return isHostAllowed(hostname, config.domains)
}

export function addDomainToConfig(
  config: LinkHoverConfig,
  raw: string,
): { ok: true; config: LinkHoverConfig } | { ok: false; error: 'invalid' | 'duplicate' } {
  const normalized = normalizeDomainEntry(raw)
  if (!normalized) return { ok: false, error: 'invalid' }
  if (config.domains.includes(normalized)) return { ok: false, error: 'duplicate' }
  return {
    ok: true,
    config: { domains: [...config.domains, normalized] },
  }
}

export function removeDomainFromConfig(
  config: LinkHoverConfig,
  domain: string,
): LinkHoverConfig {
  const target = domain.trim().toLowerCase()
  return {
    domains: config.domains.filter((d) => d !== target),
  }
}

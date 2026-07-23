/** Build-time Chrome extension pack options (`build.config*.json` → `extensions`). */

export interface ExtensionLinkHoverBake {
  domains: string[]
  urlPatterns: string[]
}

export interface ExtensionSettingsBake {
  /** When true, hide the side-panel settings (gear) button. */
  hideButton: boolean
  /** Default Page quick-open domain / URL-pattern allowlists (seeded into chrome.storage on first run). */
  linkHover: ExtensionLinkHoverBake
}

export interface ExtensionPackConfig {
  /** Solo-agent UI (hide permission control + model on mention pills; force narrow layout). */
  solo: boolean
  /** Side-panel host allowlist (`*.example.com` or `example.com`). Empty = ungated. */
  domains: string[]
  settings: ExtensionSettingsBake
}

export const DEFAULT_EXTENSION_SETTINGS_BAKE: ExtensionSettingsBake = {
  hideButton: false,
  linkHover: { domains: [], urlPatterns: [] },
}

export const DEFAULT_EXTENSION_PACK_CONFIG: ExtensionPackConfig = {
  solo: false,
  domains: [],
  settings: {
    hideButton: false,
    linkHover: { domains: [], urlPatterns: [] },
  },
}

function asStringList(raw: unknown): string[] {
  if (!Array.isArray(raw)) return []
  const out: string[] = []
  const seen = new Set<string>()
  for (const item of raw) {
    if (typeof item !== 'string') continue
    const value = item.trim()
    if (!value || seen.has(value)) continue
    seen.add(value)
    out.push(value)
  }
  return out
}

/** Normalize to a side-panel host pattern (`*.shopee.io`). */
export function toSidePanelDomain(raw: string): string | null {
  let value = raw.trim().toLowerCase()
  if (!value) return null
  value = value.replace(/^[a-z][a-z0-9+.-]*:\/\//i, '')
  value = value.split('/')[0] || ''
  value = value.split('?')[0]?.split('#')[0] || ''
  value = value.replace(/\.$/, '')
  return value || null
}

export function parseExtensionSettingsBake(raw: unknown): ExtensionSettingsBake {
  if (!raw || typeof raw !== 'object') {
    return {
      hideButton: DEFAULT_EXTENSION_SETTINGS_BAKE.hideButton,
      linkHover: {
        domains: [...DEFAULT_EXTENSION_SETTINGS_BAKE.linkHover.domains],
        urlPatterns: [...DEFAULT_EXTENSION_SETTINGS_BAKE.linkHover.urlPatterns],
      },
    }
  }

  const row = raw as {
    hideButton?: unknown
    linkHover?: unknown
  }

  const linkHoverRaw =
    row.linkHover && typeof row.linkHover === 'object'
      ? (row.linkHover as { domains?: unknown; urlPatterns?: unknown })
      : null

  return {
    hideButton: row.hideButton === true,
    linkHover: {
      domains: asStringList(linkHoverRaw?.domains),
      urlPatterns: asStringList(linkHoverRaw?.urlPatterns),
    },
  }
}

export function parseExtensionPackConfig(raw: unknown): ExtensionPackConfig {
  if (!raw || typeof raw !== 'object') {
    return {
      solo: false,
      domains: [],
      settings: parseExtensionSettingsBake(undefined),
    }
  }

  const row = raw as {
    solo?: unknown
    domains?: unknown
    settings?: unknown
  }

  const domains: string[] = []
  const seen = new Set<string>()
  for (const item of asStringList(row.domains)) {
    const domain = toSidePanelDomain(item)
    if (!domain || seen.has(domain)) continue
    seen.add(domain)
    domains.push(domain)
  }

  return {
    solo: row.solo === true,
    domains,
    settings: parseExtensionSettingsBake(row.settings),
  }
}

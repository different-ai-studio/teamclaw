'use strict'

/**
 * Chrome extension pack options from `build.config*.json` → `extensions`.
 * No CLI / env overrides — config file is the only source.
 */

function asStringList(raw) {
  if (!Array.isArray(raw)) return []
  const out = []
  const seen = new Set()
  for (const item of raw) {
    if (typeof item !== 'string') continue
    const value = item.trim()
    if (!value || seen.has(value)) continue
    seen.add(value)
    out.push(value)
  }
  return out
}

/**
 * Normalize a domain entry for the side-panel host gate.
 * Accepts either `*.shopee.io` or a Chrome match pattern `https://*.shopee.io/*`.
 */
function toSidePanelDomain(raw) {
  let value = String(raw || '').trim().toLowerCase()
  if (!value) return null
  value = value.replace(/^[a-z][a-z0-9+.-]*:\/\//i, '')
  value = value.split('/')[0] || ''
  value = value.split('?')[0]?.split('#')[0] || ''
  value = value.replace(/\.$/, '')
  return value || null
}

/** Chrome match pattern for manifest host_permissions / content_scripts.matches. */
function toChromeMatchPattern(raw) {
  const value = String(raw || '').trim()
  if (!value) return null
  if (/^https?:\/\//i.test(value)) {
    if (value.includes('*') || /\/./.test(value.slice(value.indexOf('://') + 3))) {
      return value
    }
    return value.endsWith('/') ? `${value}*` : `${value}/*`
  }
  return `https://${value}/*`
}

function parseExtensionsConfig(raw) {
  const row = raw && typeof raw === 'object' ? raw : {}
  const domainsRaw = asStringList(row.domains)
  const domains = []
  const seen = new Set()
  for (const item of domainsRaw) {
    const domain = toSidePanelDomain(item)
    if (!domain || seen.has(domain)) continue
    seen.add(domain)
    domains.push(domain)
  }

  const settingsRaw = row.settings && typeof row.settings === 'object' ? row.settings : {}
  const linkHoverRaw =
    settingsRaw.linkHover && typeof settingsRaw.linkHover === 'object'
      ? settingsRaw.linkHover
      : {}

  return {
    solo: row.solo === true,
    domains,
    settings: {
      hideButton: settingsRaw.hideButton === true,
      linkHover: {
        domains: asStringList(linkHoverRaw.domains),
        urlPatterns: asStringList(linkHoverRaw.urlPatterns),
      },
    },
  }
}

function domainsToChromeMatchPatterns(domains) {
  const out = []
  const seen = new Set()
  for (const item of domains) {
    const pattern = toChromeMatchPattern(item)
    if (!pattern || seen.has(pattern)) continue
    seen.add(pattern)
    out.push(pattern)
  }
  return out
}

function domainsToSidePanelCsv(domains) {
  return parseExtensionsConfig({ domains }).domains.join(',')
}

module.exports = {
  parseExtensionsConfig,
  toSidePanelDomain,
  toChromeMatchPattern,
  domainsToChromeMatchPatterns,
  domainsToSidePanelCsv,
}

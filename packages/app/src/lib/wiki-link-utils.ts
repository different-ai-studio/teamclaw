export interface WikiLinkParts {
  target: string
  alias: string | null
  heading: string | null
}

/**
 * Parse the text content inside [[...]] into structured parts.
 * Supports: [[target]], [[target|alias]], [[target#heading]], [[target#heading|alias]]
 */
export function parseWikiLinkText(raw: string): WikiLinkParts {
  const trimmed = raw.trim()

  let target = trimmed
  let alias: string | null = null
  let heading: string | null = null

  // Extract alias (first pipe)
  const pipeIdx = target.indexOf('|')
  if (pipeIdx !== -1) {
    alias = target.slice(pipeIdx + 1)
    target = target.slice(0, pipeIdx)
  }

  // Extract heading (first hash)
  const hashIdx = target.indexOf('#')
  if (hashIdx !== -1) {
    heading = target.slice(hashIdx + 1)
    target = target.slice(0, hashIdx)
  }

  return { target, alias, heading }
}

/**
 * Serialize wiki link parts back to [[...]] string.
 */
export function serializeWikiLink(parts: WikiLinkParts): string {
  let inner = parts.target
  if (parts.heading) inner += `#${parts.heading}`
  if (parts.alias) inner += `|${parts.alias}`
  return `[[${inner}]]`
}

/**
 * Regex that matches [[...]] wiki link syntax in a string.
 * Capture group 1 = content inside brackets.
 */
export const WIKI_LINK_REGEX = /\[\[([^\]]+)\]\]/g

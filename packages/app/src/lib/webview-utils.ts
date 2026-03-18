/** Ensure URL has a protocol prefix */
export function normalizeUrl(url: string): string {
  if (!url) return url
  if (!/^https?:\/\//i.test(url)) {
    return `https://${url}`
  }
  return url
}

/**
 * Generate a stable, deterministic label from the URL.
 * Same URL always produces the same label so we can reuse native webviews.
 */
export function urlToLabel(url: string): string {
  return `wv-${normalizeUrl(url).replace(/[^a-zA-Z0-9]/g, "_").slice(0, 60)}`
}

export function getTrailingPathLabel(path: string): string {
  const normalized = path.replace(/\\/g, "/").replace(/\/+$/, "")
  const segments = normalized.split("/").filter(Boolean)
  return segments[segments.length - 1] || path
}

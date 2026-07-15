/** Parse rgb/rgba() to relative luminance (0–1). Returns null when unknown. */
export function luminanceFromCssColor(color: string): number | null {
  const m = color.match(/rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)/i)
  if (!m) return null
  const r = Number(m[1]) / 255
  const g = Number(m[2]) / 255
  const b = Number(m[3]) / 255
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

export function isDarkBackgroundLuminance(luminance: number): boolean {
  return luminance < 0.45
}

/** Walk ancestors for the first non-transparent background color. */
export function detectDarkContext(
  el: Element,
  getBg: (node: Element) => string,
): boolean {
  let cur: Element | null = el
  while (cur) {
    const bg = getBg(cur).trim()
    if (bg && bg !== 'transparent' && bg !== 'rgba(0, 0, 0, 0)') {
      const lum = luminanceFromCssColor(bg)
      if (lum !== null) return isDarkBackgroundLuminance(lum)
    }
    cur = cur.parentElement
  }
  return false
}

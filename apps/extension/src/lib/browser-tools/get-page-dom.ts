export type GetPageDomMode = 'outline' | 'text'

export type GetPageDomArgs = {
  mode?: GetPageDomMode
  max_chars?: number
}

export type GetPageDomResult = {
  url: string
  title: string
  mode: GetPageDomMode
  content: string
  truncated: boolean
}

const HEADING_SELECTOR = 'h1, h2, h3'
const INTERACTIVE_SELECTOR =
  'button, input, select, textarea, a[href]'

function visibleText(el: Element): string {
  return (el.textContent ?? '').replace(/\s+/g, ' ').trim()
}

function describeInteractive(el: Element): string {
  const tag = el.tagName.toLowerCase()
  if (tag === 'a') {
    const href = (el as HTMLAnchorElement).getAttribute('href') ?? ''
    const text = visibleText(el)
    return text ? `a: ${text} (${href})` : `a: ${href}`
  }
  if (tag === 'input') {
    const input = el as HTMLInputElement
    const name = input.name || input.placeholder || input.type
    return `input: ${name}`
  }
  if (tag === 'textarea' || tag === 'select' || tag === 'button') {
    const label = visibleText(el) || (el as HTMLInputElement).name || tag
    return `${tag}: ${label}`
  }
  return `${tag}: ${visibleText(el)}`
}

export function extractDomOutline(doc: Document): string {
  const lines: string[] = []
  for (const h of doc.querySelectorAll(HEADING_SELECTOR)) {
    const text = visibleText(h)
    if (text) lines.push(text)
  }
  for (const el of doc.querySelectorAll(INTERACTIVE_SELECTOR)) {
    const line = describeInteractive(el)
    if (line) lines.push(line)
  }
  return lines.join('\n')
}

export function extractDomText(doc: Document, maxChars: number): { content: string; truncated: boolean } {
  const raw = doc.body?.innerText ?? ''
  if (raw.length <= maxChars) {
    return { content: raw, truncated: false }
  }
  return { content: raw.slice(0, maxChars), truncated: true }
}

export function buildGetPageDomResult(
  doc: Document,
  args: GetPageDomArgs,
): GetPageDomResult {
  const mode: GetPageDomMode = args.mode === 'text' ? 'text' : 'outline'
  const maxChars =
    typeof args.max_chars === 'number' && Number.isFinite(args.max_chars)
      ? Math.min(16_000, Math.max(1, Math.floor(args.max_chars)))
      : 8000

  if (mode === 'text') {
    const { content, truncated } = extractDomText(doc, maxChars)
    return {
      url: doc.location?.href ?? '',
      title: doc.title ?? '',
      mode,
      content,
      truncated,
    }
  }

  let content = extractDomOutline(doc)
  let truncated = false
  if (content.length > maxChars) {
    content = content.slice(0, maxChars)
    truncated = true
  }
  return {
    url: doc.location?.href ?? '',
    title: doc.title ?? '',
    mode,
    content,
    truncated,
  }
}

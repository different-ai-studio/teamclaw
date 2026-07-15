export type ExtractedPage = { title: string; url: string; text: string; selection: string }

export function extractPage(
  doc: Document,
  win: { getSelection(): { toString(): string } | null },
): ExtractedPage {
  const selection = win.getSelection()?.toString() ?? ''
  return {
    title: doc.title ?? '',
    url: doc.location?.href ?? '',
    text: doc.body?.innerText ?? '',
    selection,
  }
}

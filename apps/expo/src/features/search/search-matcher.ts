/**
 * iOS `SearchMatcher` parity. Splits the query into whitespace-separated
 * tokens, lowercases everything, and matches when *every* token appears
 * somewhere in the joined haystack.
 */

/**
 * Case- and diacritic-insensitive form, standing in for Swift's
 * `.folding(options: [.diacriticInsensitive, .caseInsensitive])`.
 *
 * The mark-stripping matters in both directions. Decomposing alone (NFKD
 * without the strip) leaves the combining accent on the haystack, so "jose"
 * finds "José" but "josé" does not find "Jose" — searching *with* an accent
 * silently under-matches, which is the direction a user typing their own name
 * is most likely to hit.
 */
export function foldForSearch(value: string): string {
  return value
    .toLocaleLowerCase()
    .normalize("NFKD")
    // Unicode combining marks, left behind by the decomposition above.
    .replace(/\p{M}/gu, "")
    .trim();
}

function normalize(value: string): string {
  return foldForSearch(value);
}

export function matchesQuery(haystack: string, query: string): boolean {
  const q = normalize(query);
  if (q.length === 0) return true;
  const hay = normalize(haystack);
  if (hay.length === 0) return false;
  const tokens = q.split(/\s+/).filter(Boolean);
  return tokens.every((token) => hay.includes(token));
}

export function matchesAnyField(fields: ReadonlyArray<string | null | undefined>, query: string): boolean {
  return matchesQuery(fields.filter(Boolean).join(" "), query);
}

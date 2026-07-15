/**
 * iOS `SearchMatcher` parity. Splits the query into whitespace-separated
 * tokens, lowercases everything, and matches when *every* token appears
 * somewhere in the joined haystack. Stripped of CJK-specific folding
 * because RN/JS doesn't ship `String.folding(options:)`; the simple
 * substring path is good enough for the small in-memory data we filter.
 */
function normalize(value: string): string {
  return value.toLocaleLowerCase().trim();
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

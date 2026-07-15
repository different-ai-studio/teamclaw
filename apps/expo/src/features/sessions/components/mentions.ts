export type MentionTarget = {
  actorId: string;
  displayName: string;
};

/**
 * Returns the in-progress `@<query>` token at the end of `composerText`,
 * mirroring iOS `SessionComposer.mentionQuery`. Walks backwards from
 * the end collecting word characters until it hits an `@`. Returns the
 * substring after that `@` (possibly empty), or null when the cursor
 * isn't on a mention token (e.g. mid-word with no `@`, or `@` followed
 * by punctuation).
 */
export function mentionQuery(composerText: string): string | null {
  if (composerText.length === 0) return null;
  let query = "";
  for (let i = composerText.length - 1; i >= 0; i -= 1) {
    const ch = composerText.charAt(i);
    if (ch === "@") {
      if (i === 0) return query;
      const prev = composerText.charAt(i - 1);
      if (/\s|[.,!?;:()[\]{}<>　。，！？]/.test(prev)) {
        return query;
      }
      return null;
    }
    if (/[A-Za-z0-9_.\-一-鿿]/.test(ch)) {
      query = ch + query;
      continue;
    }
    return null;
  }
  return null;
}

export function filterMentionCandidates(
  pool: ReadonlyArray<MentionTarget>,
  query: string,
): MentionTarget[] {
  const needle = query.toLowerCase();
  if (needle.length === 0) return [...pool].slice(0, 5);
  return pool
    .filter((target) => target.displayName.toLowerCase().includes(needle))
    .slice(0, 5);
}

/**
 * Replaces the in-progress mention token at the end of `composerText`
 * with `@<displayName> ` (trailing space). Returns the same input if
 * no mention is in progress.
 */
export function applyMention(composerText: string, target: MentionTarget): string {
  const query = mentionQuery(composerText);
  if (query === null) return composerText;
  const head = composerText.slice(0, composerText.length - query.length - 1);
  return `${head}@${target.displayName} `;
}

export function topicMatches(filter: string, topic: string): boolean {
  const fp = filter.split("/");
  const tp = topic.split("/");
  for (let i = 0; i < fp.length; i++) {
    const f = fp[i];
    if (f === "#") {
      return tp.length > i; // at least one segment must remain
    }
    if (i >= tp.length) return false;
    if (f === "+") continue;
    if (f !== tp[i]) return false;
  }
  return fp.length === tp.length;
}

/** Returns the segment values matched by `+` wildcards, in order, or null. */
export function extractWildcards(filter: string, topic: string): string[] | null {
  if (!topicMatches(filter, topic)) return null;
  const fp = filter.split("/");
  const tp = topic.split("/");
  const out: string[] = [];
  for (let i = 0; i < fp.length; i++) {
    if (fp[i] === "+") out.push(tp[i] ?? "");
  }
  return out;
}

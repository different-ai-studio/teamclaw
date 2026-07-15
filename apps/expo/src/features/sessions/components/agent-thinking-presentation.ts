const THINKING_FALLBACK = "Working…";

const PUNCTUATION_ONLY = /^[\s.。…⋯·•,，;；:：!！?？'"“”‘’`~_\-—–()[\]{}<>《》|/\\]+$/u;

function compactWhitespace(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function isPlaceholderThinking(text: string): boolean {
  const compact = compactWhitespace(text);
  return compact.length === 0 || PUNCTUATION_ONLY.test(compact);
}

export function buildThinkingPreview(text: string, maxChars = 56): string {
  const compact = compactWhitespace(text);
  if (isPlaceholderThinking(compact)) {
    return THINKING_FALLBACK;
  }
  if (compact.length <= maxChars) {
    return compact;
  }
  const head = compact.slice(0, maxChars).replace(/\s+\S*$/, "").trimEnd();
  return `${head || compact.slice(0, maxChars).trimEnd()}…`;
}

export function buildThinkingBody(text: string): string {
  const trimmed = text.trim();
  if (isPlaceholderThinking(trimmed)) {
    return THINKING_FALLBACK;
  }
  return trimmed;
}

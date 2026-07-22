import { useSessionListStore } from "@/stores/session-list-store";

/** Matches `createSessionShell` title truncation. */
export const SESSION_AUTO_TITLE_MAX_LEN = 80;

const PLACEHOLDER_EXACT = new Set(["New chat", "New Chat"]);

/**
 * Quick-empty / solo-agent sessions are created as `DisplayName (HH:mm)`.
 * Extension link sessions use the same time suffix. Both stay unreadable in
 * the list until the first user message renames them.
 */
const SOLO_TIME_TITLE_RE = /^.+ \(\d{2}:\d{2}\)$/;

/** Prefix line from `buildStructuredMentionLines`. */
const AGENT_MENTION_LINE_RE = /^\[Mentioned agents:[^\]]*\]$/i;
/** Standalone human mention chip line (rare; usually inline). */
const HUMAN_MENTION_ONLY_LINE_RE =
  /^\[Mentioned:[^\]]*\|instruction:[^\]]*\]$/i;
/** Inline human chips embedded in body text. */
const INLINE_HUMAN_MENTION_RE =
  /\[Mentioned:[^\]]*\|instruction:[^\]]*\]/gi;

/**
 * Drop agent/human mention markup so the title comes from user-authored text
 * (e.g. skip `[Mentioned agents: SPRBOT]` → keep `深圳宝安有什么推荐的美食?`).
 */
export function stripMentionsForSessionTitle(content: string): string {
  return content
    .split(/\n+/)
    .map((line) => {
      const trimmed = line.trim();
      if (!trimmed) return "";
      if (AGENT_MENTION_LINE_RE.test(trimmed)) return "";
      if (HUMAN_MENTION_ONLY_LINE_RE.test(trimmed)) return "";
      return trimmed.replace(INLINE_HUMAN_MENTION_RE, "").replace(/\s+/g, " ").trim();
    })
    .filter(Boolean)
    .join("\n");
}

export function summarizeSessionTitleFromMessage(content: string): string {
  const body = stripMentionsForSessionTitle(content);
  return (body.split("\n")[0] || body).trim().slice(0, SESSION_AUTO_TITLE_MAX_LEN);
}

export function isPlaceholderSessionTitle(title: string): boolean {
  const trimmed = title.trim();
  if (!trimmed) return true;
  if (PLACEHOLDER_EXACT.has(trimmed)) return true;
  return SOLO_TIME_TITLE_RE.test(trimmed);
}

/**
 * If the session still has a placeholder title, rename it from the first user
 * message summary. Idempotent: skips once the title is no longer a placeholder
 * (manual rename, prior auto-title, or create-with-first-message paths).
 */
export async function maybeAutoTitleSessionFromFirstMessage(
  sessionId: string,
  messageContent: string,
): Promise<boolean> {
  const summary = summarizeSessionTitleFromMessage(messageContent);
  if (!summary) return false;

  const row = useSessionListStore.getState().rows.find((r) => r.id === sessionId);
  const current = (row?.title ?? "").trim();
  if (!isPlaceholderSessionTitle(current)) return false;
  if (summary === current) return false;

  await useSessionListStore.getState().updateSessionTitle(sessionId, summary);
  return true;
}

import {
  agentReplyTextsEquivalent,
  pickCanonicalAgentReplyText,
} from "@/lib/agent-reply-text";
import type { Message as TeamclawMessage } from "@/lib/proto/teamclaw_pb";
import type { MessagePart } from "@/stores/session-types";

export type TranscriptPart = {
  type?: string;
  text?: string;
  content?: string;
};

/** Join ordered text parts for message.content (derived view, not a second source). */
export function joinTextPartsFromParts(parts: TranscriptPart[]): string {
  return parts
    .filter((part) => part.type === "text")
    .map((part) => (part.text || part.content || "").trim())
    .filter(Boolean)
    .join("\n\n");
}

function lastTextPartIndex(parts: MessagePart[]): number {
  for (let index = parts.length - 1; index >= 0; index -= 1) {
    if (parts[index]?.type === "text") return index;
  }
  return -1;
}

function lastToolPartIndex(parts: MessagePart[]): number {
  for (let index = parts.length - 1; index >= 0; index -= 1) {
    if (parts[index]?.type === "tool-call") return index;
  }
  return -1;
}

/** Text bodies that appear before the last tool-call boundary. */
export function priorTextBodiesBeforeLastTool(parts: MessagePart[]): string[] {
  const lastToolIndex = lastToolPartIndex(parts);
  if (lastToolIndex < 0) return [];
  const end = lastToolIndex;
  return parts
    .slice(0, end + 1)
    .filter((part) => part.type === "text")
    .map((part) => (part.text || part.content || "").trim())
    .filter(Boolean);
}

/**
 * When acp.output sends a cumulative chunk after tools, keep only the post-tool
 * suffix so earlier text parts are not duplicated.
 */
export function stripPriorTranscriptTextPrefix(
  parts: MessagePart[],
  candidate: string,
): string {
  if (!candidate) return "";

  const priorTexts = priorTextBodiesBeforeLastTool(parts);
  if (priorTexts.length === 0) return candidate;

  const trimmed = candidate.trim();
  if (!trimmed) return "";

  // Incremental acp.output token deltas often carry meaningful leading spaces
  // (e.g. " J", " page"). Only rewrite when we actually strip a cumulative
  // pre-tool prefix; otherwise return the delta unchanged.
  let text = trimmed;
  let strippedPrefix = false;
  for (const prior of priorTexts) {
    if (!prior) continue;
    if (text === prior || agentReplyTextsEquivalent(text, prior)) return "";
    if (text.startsWith(prior)) {
      text = text.slice(prior.length).replace(/^\s*\n+\s*/, "");
      strippedPrefix = true;
    }
  }

  const joinedPrior = priorTexts.join("\n\n");
  if (joinedPrior && text.startsWith(joinedPrior)) {
    text = text.slice(joinedPrior.length).replace(/^\s*\n+\s*/, "");
    strippedPrefix = true;
  }

  if (!strippedPrefix) return candidate;

  return text;
}

/** Derive message.content from the live transcript; pending is metadata + drift hint only. */
export function deriveAgentReplyContent(
  parts: TranscriptPart[],
  pending: TeamclawMessage[],
): string {
  const textParts = parts.filter(
    (part) => part.type === "text" && Boolean((part.text || part.content)?.trim()),
  );
  const daemonFinal = pending[pending.length - 1]?.content?.trim() ?? "";

  if (textParts.length === 0) {
    const joinedPending = pending
      .map((message) => message.content?.trim())
      .filter(Boolean)
      .filter((text, index, all) => index === 0 || text !== all[index - 1])
      .join("\n\n");
    return joinedPending || daemonFinal;
  }

  if (textParts.length === 1) {
    const partText = (textParts[0].text || textParts[0].content || "").trim();
    if (!daemonFinal) return partText;
    const hasTools = parts.some((part) => part.type === "tool-call");
    if (
      hasTools &&
      partText &&
      !partText.includes(daemonFinal) &&
      !daemonFinal.includes(partText) &&
      !agentReplyTextsEquivalent(partText, daemonFinal)
    ) {
      return `${partText}\n\n${daemonFinal}`;
    }
    return pickCanonicalAgentReplyText(partText, daemonFinal);
  }

  if (textParts.length > 1) {
    const joined = joinTextPartsFromParts(parts);
    if (!daemonFinal) return joined;
    if (daemonFinalDuplicatesTranscript(parts as MessagePart[], daemonFinal)) return daemonFinal;
    if (joined.includes(daemonFinal) || daemonFinal.includes(joined)) {
      return pickCanonicalAgentReplyText(joined, daemonFinal);
    }
    // QoS0 may drop post-tool stream deltas; daemon final still carries that tail.
    const hasTools = parts.some((part) => part.type === "tool-call");
    if (hasTools) {
      return joined ? `${joined}\n\n${daemonFinal}` : daemonFinal;
    }
    return pickCanonicalAgentReplyText(joined, daemonFinal);
  }

  return joinTextPartsFromParts(parts);
}

/** True when daemon final text is a cumulative superset of the live transcript. */
export function daemonFinalDuplicatesTranscript(
  parts: MessagePart[],
  finalText: string,
): boolean {
  const trimmed = finalText.trim();
  if (!trimmed) return false;
  const joined = joinTextPartsFromParts(parts);
  if (!joined) return false;
  if (trimmed === joined) return true;
  if (trimmed.startsWith(joined) && /^[\s\n]/.test(trimmed.slice(joined.length))) {
    return true;
  }
  const priorTexts = priorTextBodiesBeforeLastTool(parts);
  if (priorTexts.length === 0) return false;
  const first = priorTexts[0];
  return Boolean(first && trimmed.startsWith(first) && trimmed.length > first.length);
}

/** Update only the last post-tool text part when finalText is a terminal slice. */
export function replaceLastPostToolTextPart(
  parts: MessagePart[],
  finalText: string,
): MessagePart[] {
  const lastToolIndex = lastToolPartIndex(parts);
  if (lastToolIndex < 0) return parts;

  const slice = stripPriorTranscriptTextPrefix(parts, finalText);
  if (!slice) return parts;

  let lastPostToolText = -1;
  for (let index = parts.length - 1; index > lastToolIndex; index -= 1) {
    if (parts[index]?.type === "text") {
      lastPostToolText = index;
      break;
    }
  }

  if (lastPostToolText === -1) return parts;

  return parts.map((part, index) =>
    index === lastPostToolText
      ? { ...part, text: slice, content: slice }
      : part,
  );
}

export function reconcileSingleSegmentDrift(
  parts: MessagePart[],
  finalText: string,
): MessagePart[] {
  const lastTextIndex = lastTextPartIndex(parts);
  if (lastTextIndex === -1) return parts;
  const canonical = pickCanonicalAgentReplyText(
    (parts[lastTextIndex].text || parts[lastTextIndex].content || "").trim(),
    finalText.trim(),
  );
  return parts.map((part, index) =>
    index === lastTextIndex ? { ...part, text: canonical, content: canonical } : part,
  );
}

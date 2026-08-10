/**
 * One-line summaries for tool-call arguments, ported from iOS `ToolDisplay`
 * (`AMUXSharedUI/ToolCallView.swift`).
 *
 * A tool call's arguments are an arbitrary JSON blob. The row shows one line of
 * it, so the job is picking which line: the fields a reader recognises a call
 * by — the path it touched, the query it ran, the command it executed — ahead
 * of whatever happens to sort first.
 */

import type { SessionMessage } from "./session-types";

/**
 * Keys worth showing, in the order iOS prefers them. Anything matching comes
 * before the alphabetical fallback.
 */
const PREFERRED_KEYS = [
  "file_path", "filepath", "path", "file", "filename",
  "query", "pattern", "q", "command", "cmd",
  "skill", "skill_name", "name", "url",
] as const;

const SUMMARY_CACHE_CAPACITY = 256;

/**
 * Bounded FIFO cache keyed by the raw description.
 *
 * Descriptions are stable per event, so the same key is hit on every re-render
 * while a row is on screen. iOS caps this at 256 entries; matching that keeps
 * a long session's visible rows covered at negligible cost.
 */
const summaryCache = new Map<string, string | null>();

function cacheGet(key: string): { hit: boolean; value: string | null } {
  if (!summaryCache.has(key)) return { hit: false, value: null };
  return { hit: true, value: summaryCache.get(key) ?? null };
}

function cacheSet(key: string, value: string | null): void {
  if (!summaryCache.has(key) && summaryCache.size >= SUMMARY_CACHE_CAPACITY) {
    // Map preserves insertion order, so the first key is the oldest.
    const oldest = summaryCache.keys().next();
    if (!oldest.done) summaryCache.delete(oldest.value);
  }
  summaryCache.set(key, value);
}

/** Test-only: drop the cache so a case can't be answered by an earlier one. */
export function __resetToolSummaryCache(): void {
  summaryCache.clear();
}

function truncate(text: string, limit: number): string {
  if (text.length <= limit) return text;
  return `${text.slice(0, limit - 1)}…`;
}

function displayKey(key: string): string {
  return key.replace(/_/g, " ");
}

function renderScalar(value: unknown): string | null {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed.length === 0 ? null : trimmed.replace(/\n/g, " ");
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  if (Array.isArray(value)) {
    return `${value.length} items`;
  }
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    // A nested object is only worth a line if it names something.
    const nested = record.path ?? record.file_path ?? record.name;
    return nested === undefined ? null : renderScalar(nested);
  }
  return null;
}

function summarizeJson(parsed: unknown): string | null {
  if (Array.isArray(parsed)) {
    return `${parsed.length} items`;
  }
  if (parsed && typeof parsed === "object") {
    const record = parsed as Record<string, unknown>;
    let pairs: Array<[string, string]> = [];
    for (const key of PREFERRED_KEYS) {
      const rendered = key in record ? renderScalar(record[key]) : null;
      if (rendered !== null) pairs.push([displayKey(key), rendered]);
    }
    if (pairs.length === 0) {
      pairs = Object.keys(record)
        .sort()
        .map((key): [string, string] | null => {
          const rendered = renderScalar(record[key]);
          return rendered === null ? null : [displayKey(key), rendered];
        })
        .filter((pair): pair is [string, string] => pair !== null);
    }
    if (pairs.length === 0) return null;
    return pairs
      .slice(0, 2)
      .map(([key, value]) => `${key}: ${truncate(value, 48)}`)
      .join(" · ");
  }
  const scalar = renderScalar(parsed);
  return scalar === null ? null : truncate(scalar, 80);
}

function computeToolSummary(description: string): string | null {
  const trimmed = description.trim();
  if (trimmed.length === 0 || trimmed === "{}" || trimmed === "null") return null;
  try {
    return summarizeJson(JSON.parse(trimmed));
  } catch {
    // Not JSON — show the text itself, flattened onto one line.
    return truncate(trimmed.replace(/\n/g, " "), 80);
  }
}

/**
 * One line describing a tool call's arguments, or null when there is nothing
 * worth showing — which is also what makes a row non-expandable.
 */
export function toolSummary(description: string): string | null {
  const cached = cacheGet(description);
  if (cached.hit) return cached.value;
  const computed = computeToolSummary(description);
  cacheSet(description, computed);
  return computed;
}

export type ToolCallStatus = "running" | "completed" | "failed" | "unknown";

export type ToolCallPresentation = {
  /** Uppercased tool name, or the tool id when the name is missing. */
  label: string;
  toolId: string;
  /** Raw argument text, shown when the row is expanded. */
  description: string;
  /** One-line argument summary; null means the row cannot be expanded. */
  summary: string | null;
  status: ToolCallStatus;
};

function metadataRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

function readString(record: Record<string, unknown>, ...keys: string[]): string {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim().length > 0) return value.trim();
  }
  return "";
}

/**
 * Shapes an `agent_tool_call` message into what the row renders.
 *
 * The daemon sends arguments as a `params` object; the message content is a
 * pre-joined human string. Prefer the structured params — that is what
 * `toolSummary` is built to read, and it is what iOS gets.
 */
export function toolCallPresentation(
  message: Pick<SessionMessage, "content" | "metadata">,
  result?: ToolResult,
): ToolCallPresentation {
  const metadata = metadataRecord(message.metadata);
  const toolId = readString(metadata, "tool_id", "toolId");
  const toolName = readString(metadata, "tool_name", "toolName");
  const params = metadata.params;
  const description =
    params && typeof params === "object" && Object.keys(params).length > 0
      ? JSON.stringify(params)
      : message.content;
  return {
    label: (toolName || toolId).toUpperCase(),
    toolId,
    description,
    summary: toolSummary(description),
    status: toolCallStatus(result),
  };
}

export type ToolResult = {
  summary: string;
  success: boolean;
};

function toolCallStatus(result: ToolResult | undefined): ToolCallStatus {
  if (!result) return "running";
  return result.success ? "completed" : "failed";
}

/**
 * Folds `agent_tool_result` messages into the calls they answer.
 *
 * The daemon emits a call and its result as two messages sharing a `tool_id`.
 * iOS pairs them upstream so one row carries both; Expo kept them as two
 * unrelated cards, which is why a failed tool looked exactly like a successful
 * one — the failure lived in the second card's metadata and was never read.
 *
 * Returns the results keyed by tool id, plus the ids of the result messages
 * that were folded in so the caller can drop them from the feed. A result with
 * no matching call is left alone rather than silently swallowed.
 */
export function foldToolResults(
  messages: ReadonlyArray<Pick<SessionMessage, "messageId" | "kind" | "content" | "metadata">>,
): { resultByToolId: Map<string, ToolResult>; foldedMessageIds: Set<string> } {
  const callToolIds = new Set<string>();
  for (const message of messages) {
    if (message.kind.trim().toLowerCase() !== "agent_tool_call") continue;
    const toolId = readString(metadataRecord(message.metadata), "tool_id", "toolId");
    if (toolId) callToolIds.add(toolId);
  }

  const resultByToolId = new Map<string, ToolResult>();
  const foldedMessageIds = new Set<string>();
  for (const message of messages) {
    if (message.kind.trim().toLowerCase() !== "agent_tool_result") continue;
    const metadata = metadataRecord(message.metadata);
    const toolId = readString(metadata, "tool_id", "toolId");
    if (!toolId || !callToolIds.has(toolId)) continue;
    resultByToolId.set(toolId, {
      summary: message.content.trim(),
      // Absent means it did not report a failure — same default as iOS's
      // `event.success != false`.
      success: metadata.success !== false,
    });
    foldedMessageIds.add(message.messageId);
  }
  return { resultByToolId, foldedMessageIds };
}

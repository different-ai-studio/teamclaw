import type { OpenCodeMessage } from "./types";

const MEDIA_PART_TYPES = new Set(["image", "video", "audio", "file"]);
const INLINE_PAYLOAD_KEYS = new Set(["base64", "binary", "bytes", "data"]);
const DATA_URL_RE = /^data:[^;]+;base64,/i;
const BASE64_LIKE_RE = /^[A-Za-z0-9+/=\s]+$/;
const INLINE_PAYLOAD_MIN_LENGTH = 256;

function isMediaPart(part: unknown): boolean {
  return (
    typeof part === "object" &&
    part !== null &&
    MEDIA_PART_TYPES.has(String((part as Record<string, unknown>).type))
  );
}

function isLargeInlinePayload(value: unknown): boolean {
  if (typeof value !== "string") {
    return false;
  }
  if (value.length < INLINE_PAYLOAD_MIN_LENGTH) {
    return false;
  }
  if (DATA_URL_RE.test(value)) {
    return true;
  }
  const compact = value.replace(/\s/g, "");
  return (
    compact.length >= INLINE_PAYLOAD_MIN_LENGTH && BASE64_LIKE_RE.test(compact)
  );
}

function sanitizeValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return sanitizeList(value);
  }
  if (typeof value === "object" && value !== null) {
    return sanitizeDict(value as Record<string, unknown>);
  }
  return value;
}

function sanitizeDict(data: Record<string, unknown>): Record<string, unknown> {
  const cleaned: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(data)) {
    const lowerKey = key.toLowerCase();
    if (INLINE_PAYLOAD_KEYS.has(lowerKey) && isLargeInlinePayload(value)) {
      continue;
    }
    if (isLargeInlinePayload(value)) {
      continue;
    }
    cleaned[key] = sanitizeValue(value);
  }
  return cleaned;
}

function sanitizeList(items: unknown[]): unknown[] {
  const cleaned: unknown[] = [];
  for (const item of items) {
    if (isMediaPart(item)) {
      continue;
    }
    cleaned.push(sanitizeValue(item));
  }
  return cleaned;
}

function sanitizeMessage(message: OpenCodeMessage): OpenCodeMessage {
  const cleaned = sanitizeDict(message) as OpenCodeMessage;
  if (Array.isArray(message.parts)) {
    cleaned.parts = sanitizeList(message.parts) as Array<Record<string, unknown>>;
  }
  return cleaned;
}

export function sanitizeOpenCodeMessages(
  messages: OpenCodeMessage[],
): OpenCodeMessage[] {
  return messages.map(sanitizeMessage);
}

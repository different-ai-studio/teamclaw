import type { SessionAttachmentRef } from "@/lib/session-attachments";
import { base64urlDecode, base64urlEncode } from "@/lib/page-link-token";

const SESSION_ATTACHMENT_PREFIX = "att:b64:";

export interface SessionAttachmentPayload {
  name: string;
  url: string;
  isImage: boolean;
}

export function encodeSessionAttachmentToken(
  ref: Pick<SessionAttachmentRef, "name" | "url" | "isImage">,
): string {
  const json = JSON.stringify({
    name: ref.name,
    url: ref.url,
    isImage: ref.isImage,
  } satisfies SessionAttachmentPayload);
  return `@{${SESSION_ATTACHMENT_PREFIX}${base64urlEncode(json)}}`;
}

export function parseSessionAttachmentBody(body: string): SessionAttachmentPayload | null {
  if (!body.startsWith(SESSION_ATTACHMENT_PREFIX)) return null;
  const encoded = body.slice(SESSION_ATTACHMENT_PREFIX.length);
  if (!encoded) return null;
  try {
    const json = base64urlDecode(encoded);
    const parsed: unknown = JSON.parse(json);
    if (typeof parsed !== "object" || parsed === null) return null;
    const p = parsed as SessionAttachmentPayload;
    if (
      typeof p.name !== "string" ||
      typeof p.url !== "string" ||
      typeof p.isImage !== "boolean" ||
      !p.url.trim()
    ) {
      return null;
    }
    return { name: p.name, url: p.url, isImage: p.isImage };
  } catch {
    return null;
  }
}

export function parseSessionAttachmentToken(token: string): SessionAttachmentPayload | null {
  if (!token.startsWith("@{") || !token.endsWith("}")) return null;
  return parseSessionAttachmentBody(token.slice(2, -1));
}

export const SESSION_ATTACHMENT_TOKEN_RE = /@\{att:b64:[^}]+\}/g;

export function parseSessionAttachmentTokensFromText(
  text: string,
): SessionAttachmentPayload[] {
  const seen = new Map<string, SessionAttachmentPayload>();
  for (const match of text.matchAll(SESSION_ATTACHMENT_TOKEN_RE)) {
    const token = match[0];
    const payload = parseSessionAttachmentToken(token);
    if (!payload || seen.has(payload.url)) continue;
    seen.set(payload.url, payload);
  }
  return [...seen.values()];
}

export function textHasSessionAttachmentTokens(text: string): boolean {
  SESSION_ATTACHMENT_TOKEN_RE.lastIndex = 0;
  return SESSION_ATTACHMENT_TOKEN_RE.test(text);
}

export function expandSessionAttachmentTokensInText(text: string): string {
  return text.replace(SESSION_ATTACHMENT_TOKEN_RE, (token) => {
    const ref = parseSessionAttachmentToken(token);
    if (!ref) return token;
    if (ref.isImage) {
      return `[Image: ${ref.name}] (url: ${ref.url})`;
    }
    return `[Attachment: ${ref.name}] (url: ${ref.url})`;
  });
}

export function collectSessionAttachmentUrlsFromText(text: string): string[] {
  return parseSessionAttachmentTokensFromText(text).map((ref) => ref.url);
}

import type { UploadedAttachment } from "./attachment-upload";

/**
 * Process-local registry of attachments the user has uploaded but not
 * yet sent. Keyed by `<teamId>:<sessionId>`. Drained by the send path
 * each time an outgoing message is dispatched.
 *
 * Lives outside React state so that the AttachmentDrawer route (a
 * separate modal) can drop entries here while the underlying detail
 * route picks them up on send. We don't persist across app restarts
 * — that's the same behavior as iOS, where the draft attachment list
 * is composer-local and is cleared on dismiss.
 */
type Listener = (key: string) => void;

const pending = new Map<string, UploadedAttachment[]>();
const listeners = new Set<Listener>();
const EMPTY_ATTACHMENTS: readonly UploadedAttachment[] = [];

function key(teamId: string, sessionId: string): string {
  return `${teamId}:${sessionId}`;
}

export function appendPendingAttachment(
  teamId: string,
  sessionId: string,
  attachment: UploadedAttachment,
): void {
  const k = key(teamId, sessionId);
  const next = [...(pending.get(k) ?? []), attachment];
  pending.set(k, next);
  for (const listener of listeners) listener(k);
}

export function takePendingAttachments(
  teamId: string,
  sessionId: string,
): UploadedAttachment[] {
  const k = key(teamId, sessionId);
  const value = pending.get(k) ?? [];
  pending.delete(k);
  if (value.length > 0) {
    for (const listener of listeners) listener(k);
  }
  return value;
}

export function getPendingAttachmentSnapshot(
  teamId: string,
  sessionId: string,
): readonly UploadedAttachment[] {
  return pending.get(key(teamId, sessionId)) ?? EMPTY_ATTACHMENTS;
}

export function peekPendingAttachments(
  teamId: string,
  sessionId: string,
): UploadedAttachment[] {
  return [...(pending.get(key(teamId, sessionId)) ?? [])];
}

export function removePendingAttachment(
  teamId: string,
  sessionId: string,
  path: string,
): void {
  const k = key(teamId, sessionId);
  const current = pending.get(k) ?? [];
  const next = current.filter((attachment) => attachment.path !== path);
  if (next.length === current.length) return;
  if (next.length > 0) {
    pending.set(k, next);
  } else {
    pending.delete(k);
  }
  for (const listener of listeners) listener(k);
}

export function subscribePendingAttachments(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

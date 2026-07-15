// apps/expo/src/features/sessions/outbox-store.ts
import type { OutboxDao, OutboxState } from "./outbox-db";

export type OutboxStatus = "sending" | "sent" | "failed";

type Listener = (snapshot: ReadonlyMap<string, OutboxStatus>) => void;

const state = new Map<string, OutboxStatus>();
const listeners = new Set<Listener>();
let snapshot: ReadonlyMap<string, OutboxStatus> = new Map(state);

function emit() {
  snapshot = new Map(state);
  for (const listener of listeners) listener(snapshot);
}

function toUiStatus(s: OutboxState): OutboxStatus | null {
  switch (s) {
    case "pending":
    case "inFlight":
      return "sending";
    case "delivered":
      return "sent";
    case "failed":
      return "failed";
  }
}

export function setOutboxStatus(messageId: string, status: OutboxStatus): void {
  if (!messageId) return;
  if (state.get(messageId) === status) return;
  state.set(messageId, status);
  emit();
}

export function clearOutboxStatus(messageId: string): void {
  if (!messageId) return;
  if (!state.has(messageId)) return;
  state.delete(messageId);
  emit();
}

export function getOutboxSnapshot(): ReadonlyMap<string, OutboxStatus> {
  return snapshot;
}

export function subscribeOutbox(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * Pulls current DAO state for the given message ids and reconciles the
 * in-memory map. The sender calls this after every transition so the UI
 * dot reflects durable state, not just optimistic guesses.
 */
export async function syncOutboxFromDao(
  dao: OutboxDao,
  messageIds: string[],
): Promise<void> {
  let changed = false;
  for (const id of messageIds) {
    const row = await dao.getByMessageId(id);
    if (!row) {
      if (state.delete(id)) changed = true;
      continue;
    }
    const next = toUiStatus(row.state);
    if (next == null) continue;
    if (state.get(id) !== next) {
      state.set(id, next);
      changed = true;
    }
  }
  if (changed) emit();
}

export function resetOutbox(): void {
  if (state.size === 0) return;
  state.clear();
  emit();
}

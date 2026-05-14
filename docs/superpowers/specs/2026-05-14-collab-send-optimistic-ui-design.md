# Collab Send: Optimistic UI with Status Indicator

**Date:** 2026-05-14
**Status:** Draft
**Branch:** `v2/amuxd-architecture`

## Problem

Today, when a user sends a message in a collab (team) session, the bubble does not appear until both `supabase.from("messages").insert()` and `mqttPublish()` resolve. On a slow connection this introduces a visible lag between clicking send and seeing anything happen, and the textarea also disables itself during the wait.

The affected entry point:

- `packages/app/src/components/chat/ChatPanel.tsx` (lines ~880–944, plus `createSessionAndSendFirst`): the main chat panel's team-session publish path.

(`ActorChatInput.tsx` exists but is dead code — exported, never imported anywhere. Out of scope; flag for deletion in a follow-up.)

The current logic: actor lookup → build proto Message → `mqttPublish` → `supabase.insert` → `appendMessage`. The append happens *last*, which is the source of the lag.

The iOS client (`feature/ios-development-1` branch, `CollabChatViewModel.sendMessage`) already does optimistic local append before publishing — it just lacks a status indicator.

## Goal

Match iOS's "bubble appears immediately" behavior on desktop and additionally surface delivery status:

1. On send click: bubble appears in the conversation immediately, with a small spinning circle to its left.
2. supabase insert + MQTT publish run in the background.
3. On success: the circle disappears (clean, sent state).
4. On failure: the circle becomes a red exclamation icon; clicking it retries with the same message id.

## Non-goals

- AI/agent chat (non-team) optimistic UI — that path already appends optimistically via `useSessionStore`'s session-messages flow.
- Persistent pending state across reloads (in-memory only for v1).
- Read receipts, delivery receipts beyond "persisted to supabase + published".
- Caching the user's actor lookup (separate optimization; out of scope).

## Design

### 1. Pending status store (parallel map)

Add a parallel pending-status map to `useSessionStore` in `packages/app/src/stores/session-store.ts`. The proto `Message` is not extended.

```ts
type PendingStatus = "sending" | "failed";

interface PendingState {
  status: PendingStatus;
  retryPayload?: {
    teamId: string;
    senderActorId: string;
    content: string;
    mentionActorIds: string[];
  };
  error?: string;
}

// State
pendingMessageStatus: Record<string /* sid */, Record<string /* mid */, PendingState>>;

// Actions
markMessageSending(sid: string, mid: string, retryPayload: PendingState["retryPayload"]): void;
markMessageFailed(sid: string, mid: string, error: string): void;
clearMessagePending(sid: string, mid: string): void;
```

Semantics: a message *not* present in the map is considered sent. Only locally-originated outgoing messages ever appear in this map.

### 2. Shared sender helper

New file `packages/app/src/lib/collab-send.ts`:

```ts
export interface SendCollabMessageOpts {
  sessionId: string;
  teamId: string;
  senderActorId: string;
  content: string;
  mentionActorIds: string[];
  /** Reuse this id on retry. If omitted, a new UUID is generated. */
  messageId?: string;
}

export async function sendCollabMessage(opts: SendCollabMessageOpts): Promise<void>;
export async function retryCollabMessage(sid: string, mid: string): Promise<void>;
```

`sendCollabMessage` flow:

1. `const messageId = opts.messageId ?? crypto.randomUUID()`.
2. `const createdAt = BigInt(Math.floor(Date.now() / 1000))`.
3. Build the proto `Message`, `SessionMessageEnvelope`, and `LiveEventEnvelope` exactly as the current code does.
4. **Optimistically** call `useSessionStore.getState().appendMessage(opts.sessionId, msg)` and `markMessageSending(opts.sessionId, messageId, { teamId, senderActorId, content, mentionActorIds })`.
5. `try`:
   - `await supabase.from("messages").upsert({ id: messageId, team_id, session_id, sender_actor_id, kind: "text", content, metadata: { mention_actor_ids: mentionActorIds } }, { onConflict: "id" })` — `upsert` makes retry idempotent in the case where supabase succeeded but MQTT failed on a previous attempt.
   - `await mqttPublish(...)` with the existing topic and envelope.
   - `clearMessagePending(opts.sessionId, messageId)`.
6. `catch (e)`: `markMessageFailed(opts.sessionId, messageId, (e as Error).message)`.

`retryCollabMessage` reads the pending entry by `(sid, mid)`, validates `status === "failed"` and `retryPayload` is present, transitions back to `"sending"`, and calls `sendCollabMessage` with `messageId: mid`.

### 3. Render status on the user bubble

Extend `interface Message` in `packages/app/src/stores/session-types.ts`:

```ts
status?: "sending" | "failed";
```

In `packages/app/src/stores/session-converters.ts`, when converting proto Message → StoreMessage, look up `useSessionStore.getState().pendingMessageStatus[sid]?.[mid]?.status` and assign it to `status`. Default (absent) means sent — no field set.

In `packages/app/src/components/chat/ChatMessage.tsx`, the user-bubble branch (currently lines 251–257) wraps the `<Message from="user">` element with a flex row that places the status icon *immediately to the left* of the bubble, both right-aligned within the message area:

```tsx
{isUser && (
  <div className="flex items-end justify-end gap-1.5">
    {latestMessage.status === "sending" && (
      <Loader2 className="h-3.5 w-3.5 shrink-0 mb-2 animate-spin text-muted-foreground/60" aria-label="sending" />
    )}
    {latestMessage.status === "failed" && (
      <button
        type="button"
        onClick={() => retryCollabMessage(latestMessage.sessionId, latestMessage.id)}
        className="shrink-0 mb-2"
        aria-label="resend"
        title="Send failed — click to retry"
      >
        <AlertCircle className="h-3.5 w-3.5 text-red-500 hover:text-red-600" />
      </button>
    )}
    <Message from="user" basePath={basePath}>
      <MessageContent>
        <UserMessageWithMentions content={textContent} basePath={basePath} />
      </MessageContent>
    </Message>
  </div>
)}
```

The icon is `mb-2` so it visually aligns with the bubble's text baseline (the bubble has internal padding). `h-3.5 w-3.5` matches the existing copy/feedback icon sizing in this file.

`Loader2` and `AlertCircle` are added to the existing `lucide-react` import.

### 4. Update the call site

**`ChatPanel.tsx`** (lines ~880–944): inside `sendIntoSession`, the `if (sid && authSession && teamIdForSend)` block:

1. Move `setInputValue("")`, `setAttachedFiles([])`, `setImageFiles([])` from the end of `sendIntoSession` (lines 946–948) to *before* the actor lookup, so the input clears the moment the user hits send.
2. Keep the team-id resolution (cache → supabase fallback) and actor lookup as-is. These are still awaited; in the rare case where the team-id cache misses, there's a small (~1 RTT) delay before the bubble appears. This is significantly better than the current behavior and acceptable for v1. (Caching the user's actor_id is listed under follow-ups.)
3. Replace the proto-build + `mqttPublish` + `supabase.insert` + `appendMessage` block with a single `void sendCollabMessage({ sessionId: sid, teamId: teamIdForSend, senderActorId, content: outgoing, mentionActorIds })`.
4. Remove the surrounding `try/catch` since failures are now reported via the bubble.

**`ChatPanel.createSessionAndSendFirst`**: same swap. The session must be created first (await), then `sendCollabMessage` is called with the new sessionId. Input clearing happens after the new session is created and active so the user sees the bubble in the new session view.

### 5. Edge cases

- **Echo from broker**: `appendMessage` already dedupes by `messageId`, so a remote echo (if any) won't double-render. No change needed.
- **Page reload mid-send**: pending status is in-memory only and is lost. If supabase succeeded, the message is still there on reload (status simply "no badge"). If supabase failed, the message is gone — acceptable for v1; user can retype.
- **Switch session mid-send**: the bubble lives in the original session's message list; the badge will still be correct when the user navigates back. `pendingMessageStatus` is keyed by `sid` so cross-session writes don't collide.
- **Concurrent retries**: `retryCollabMessage` flips status back to `"sending"` first, so a double-click can't re-enter while in flight (the second call sees `status === "sending"` and returns early).
- **`setText("")` before send**: if the actor lookup fails (rare), the bubble still appears and goes straight to "failed". The retry payload contains the original content, so the user can recover by clicking the red icon.

## Files touched

| File | Change |
|------|--------|
| `packages/app/src/stores/session-store.ts` | Add `pendingMessageStatus` state + 3 actions |
| `packages/app/src/stores/session-types.ts` | Add `status?` field to `Message` |
| `packages/app/src/stores/session-converters.ts` | Read pending map, set `status` on StoreMessage |
| `packages/app/src/lib/collab-send.ts` | New: `sendCollabMessage`, `retryCollabMessage` |
| `packages/app/src/components/chat/ChatPanel.tsx` | Use helper in `sendIntoSession` and `createSessionAndSendFirst`; clear input early |
| `packages/app/src/components/chat/ChatMessage.tsx` | Add status icon (`Loader2` / `AlertCircle`) left of user bubble |

## Testing

Unit tests (Vitest):

- `lib/__tests__/collab-send.test.ts`:
  - Optimistic append happens before any network call resolves (assert `appendMessage` called synchronously after `crypto.randomUUID`).
  - Status transitions `sending → cleared` on full success.
  - Status transitions `sending → failed` and retains `retryPayload` on supabase error.
  - Status transitions `sending → failed` on MQTT error after supabase succeeded; retry uses `upsert` so supabase doesn't 409.
  - `retryCollabMessage` reuses the same `messageId`.
  - Concurrent retry (double-click) is a no-op while `status === "sending"`.
- `stores/__tests__/session-store.pending-status.test.ts`:
  - `markMessageSending` → `markMessageFailed` → `clearMessagePending` round-trip.
  - Distinct sessions don't collide.

Manual smoke (real network):

- Send a normal collab message; bubble appears instantly, no badge after ~200ms.
- Set network to offline in DevTools, send a message; bubble appears with red exclamation. Re-enable network, click the icon, message goes to sent.
- Reload mid-send; check that a successfully-persisted message stays and a failed-supabase one disappears.

## Out of scope (follow-ups)

- Cache the user's actor_id per team to remove the per-send actor lookup.
- Persist pending sends to localStorage so they survive reload.
- Apply the same pattern to the AI-only (non-team) chat path if/when it shows similar lag.

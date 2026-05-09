# Archived Session Search Design

## Summary

TeamClaw should let users find and inspect archived conversations without adding a permanent Archive destination to the main navigation. Archived sessions remain hidden from the normal sidebar list, but the existing session search dialog gains an archived search mode. Selecting an archived result opens it in a read-only view with a clear restore action.

## Goals

- Make archived conversations recoverable from the app UI.
- Keep the default session list focused on active conversations.
- Let users inspect archived message history before deciding whether to restore.
- Provide a safe restore path that returns the conversation to the normal session list.

## Non-Goals

- Bulk archive management.
- Permanent Archive sidebar destination.
- Editing, renaming, pinning, sending messages, or running tools inside read-only archived sessions.
- Changing how active sessions are loaded by default.

## User Experience

The existing session search dialog remains the entry point. It adds a compact filter control with three modes:

- Active: default mode, matching today's behavior.
- Archived: shows only sessions with an archived timestamp.
- All: shows active and archived sessions together.

Archived results show an Archive badge and archived date alongside the title and updated date. Selecting an active result behaves as it does today. Selecting an archived result closes the dialog and opens a read-only archived session view.

The archived session view reuses the regular chat reader where practical, but disables the input and any actions that would mutate the conversation. The disabled input communicates that the session must be restored before continuing. A Restore button appears near the session heading or input area. Restoring clears the archived timestamp, reloads normal sessions, and switches the user into the restored session as a normal active conversation.

## Architecture

### Session Data

Extend the app-level `Session` type with archive metadata:

- `isArchived?: boolean`
- `archivedAt?: Date`

Update `convertSession` and `convertSessionListItem` so OpenCode's `time.archived` becomes these fields. Existing consumers that do not care about archive state can ignore the optional fields.

### SDK Client

Keep the existing `archiveSession(id, directory)` wrapper. Add a matching `restoreSession(id, directory?)` wrapper that calls OpenCode `session.update` with the archived time cleared. The implementation should use the SDK-supported representation for clearing `time.archived`; if the SDK rejects `null`, use the smallest supported update shape verified against OpenCode.

### Session Store

Keep `loadSessions` unchanged in behavior: it filters archived sessions out of the main list.

Add archive-specific state:

- `archivedSessions: Session[]`
- `isLoadingArchivedSessions: boolean`
- `archivedSessionError: string | null`
- `viewingArchivedSessionId: string | null`
- `archivedSessionMessages: Record<string, Message[]>`

Add archive-specific actions:

- `loadArchivedSessions(workspacePath?: string): Promise<void>`
- `openArchivedSession(id: string): Promise<void>`
- `closeArchivedSession(): void`
- `restoreSession(id: string): Promise<void>`

`loadArchivedSessions` calls `client.listSessions({ directory, roots: true })`, filters sessions with `time.archived` and no `parentID`, converts them, and sorts by `archivedAt` descending, falling back to `updatedAt`.

`openArchivedSession` fetches messages with `client.getMessages(id)` and stores them in `archivedSessionMessages`. It must not insert the archived session into the normal `sessions` list or make it a normal active session. This keeps active session navigation and SSE behavior unchanged.

`restoreSession` clears the archived timestamp, removes the session from `archivedSessions`, clears archived read-only state for that id, reloads normal sessions, then switches to the restored session through the normal UI flow.

### UI

Extend `SessionSearchDialog` in `AppSidebar`:

- Add local filter state: `active | archived | all`.
- Continue to read active sessions from `useSessionStore(s => s.sessions)`.
- Lazily call `loadArchivedSessions` when the filter first needs archived results.
- Render archived and active results in the same command list, with stable values that include id, title, and archive state.
- For active results, call the existing `switchToSession`.
- For archived results, call `openArchivedSession`.

Add a small read-only banner or header state to the chat surface when `viewingArchivedSessionId` is set. The chat reader should display archived messages, hide or disable live-only indicators, and disable send-related controls. The normal active session state should be restored when the user closes the archived view, starts a new chat, or selects a normal session.

## Data Flow

1. User opens Search Sessions.
2. Default filter shows active sessions from the existing store.
3. User switches to Archived or All.
4. Store loads archived sessions from OpenCode and keeps them separate from normal sessions.
5. User selects an archived result.
6. Store fetches archived messages and sets `viewingArchivedSessionId`.
7. Chat UI renders archived messages in read-only mode.
8. User clicks Restore.
9. Store clears the archived timestamp through OpenCode, reloads normal sessions, and switches to the restored session.

## Error Handling

If archived session loading fails, the search dialog shows an archived-specific error or empty state without affecting active session search. If opening an archived session fails, keep the user in their current view and set a recoverable store error. If restore fails, keep the read-only archived view open and show the error. If a session is already restored or missing, refresh archived and active lists and show a neutral message.

## Testing

Unit tests should cover:

- `loadSessions` continues to filter archived sessions.
- converters preserve `time.archived` as `isArchived` and `archivedAt`.
- `loadArchivedSessions` returns only archived parent sessions and sorts them correctly.
- `openArchivedSession` loads messages without adding the session to the normal session list.
- `restoreSession` clears archived state, reloads normal sessions, and switches to the restored session.
- `SessionSearchDialog` can filter Active, Archived, and All results.
- Archived result selection opens read-only mode.
- Chat input is disabled in archived read-only mode and restore is available.

## Implementation Detail

The Restore button should be placed where it is visible in the archived read-only view without adding a permanent sidebar destination. The exact placement should follow the existing chat header and input layout during implementation.

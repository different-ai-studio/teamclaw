# Archived Session Search Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a search-only archived session viewer that opens archived conversations read-only and lets users restore them.

**Architecture:** Keep archived sessions out of the normal session list. Add archive metadata to converted sessions, add archive-specific store state/actions, extend the existing session search dialog with Active/Archived/All modes, and render archived messages through the existing chat reader in read-only mode.

**Tech Stack:** React 19, Zustand, TypeScript, Vitest, Testing Library, `@opencode-ai/sdk/v2`, existing `cmdk` command dialog components.

---

## File Structure

- Modify `packages/app/src/lib/opencode/sdk-client.ts`
  - Add `archived?: boolean` to `listSessions`.
  - Add `restoreSession(id, directory?)`.
  - Add `restoreSession` to `OpenCodeClientCompat`.
- Modify `packages/app/src/stores/session-types.ts`
  - Add optional archive metadata fields and archive-specific store state/actions.
- Modify `packages/app/src/stores/session-converters.ts`
  - Convert OpenCode `time.archived` into `isArchived` and `archivedAt`.
- Modify `packages/app/src/stores/session-loader.ts`
  - Initialize/reset archive state.
  - Implement `loadArchivedSessions`, `openArchivedSession`, `closeArchivedSession`, and `restoreSession`.
- Modify `packages/app/src/components/app-sidebar.tsx`
  - Extend `SessionSearchDialog` with Active/Archived/All filtering and archived selection behavior.
- Modify `packages/app/src/components/chat/ChatPanel.tsx`
  - Render archived messages read-only with a restore action.
- Modify `packages/app/src/locales/en.json`
  - Add English strings for archived search and restore UI.
- Modify `packages/app/src/locales/zh-CN.json`
  - Add Chinese strings for archived search and restore UI.
- Modify `packages/app/src/stores/__tests__/session-loader.test.ts`
  - Cover archive store actions.
- Modify `packages/app/src/stores/__tests__/session-converters.test.ts`
  - Cover archive metadata conversion.
- Modify `packages/app/src/components/__tests__/app-sidebar.test.tsx`
  - Cover archived search modes and archived result selection.
- Modify `packages/app/src/components/chat/__tests__/ChatPanel.test.tsx`
  - Cover read-only archived rendering and restore action.

---

### Task 1: SDK Wrapper And Session Metadata

**Files:**
- Modify: `packages/app/src/lib/opencode/sdk-client.ts`
- Modify: `packages/app/src/stores/session-types.ts`
- Modify: `packages/app/src/stores/session-converters.ts`
- Test: `packages/app/src/stores/__tests__/session-converters.test.ts`

- [ ] **Step 1: Write failing converter tests**

Add these tests to `packages/app/src/stores/__tests__/session-converters.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { convertSession, convertSessionListItem } from "@/stores/session-converters";

describe("session converters archive metadata", () => {
  it("preserves archive metadata on full sessions", () => {
    const archivedAt = Date.parse("2026-05-06T09:30:00.000Z");

    const converted = convertSession({
      id: "ses_archived",
      title: "Archived chat",
      directory: "/workspace",
      time: {
        created: archivedAt - 2000,
        updated: archivedAt - 1000,
        archived: archivedAt,
      },
    } as never);

    expect(converted.isArchived).toBe(true);
    expect(converted.archivedAt?.toISOString()).toBe("2026-05-06T09:30:00.000Z");
  });

  it("preserves archive metadata on session list items", () => {
    const archivedAt = Date.parse("2026-05-06T09:31:00.000Z");

    const converted = convertSessionListItem({
      id: "ses_archived_list",
      title: "Archived list chat",
      directory: "/workspace",
      time: {
        created: archivedAt - 2000,
        updated: archivedAt - 1000,
        archived: archivedAt,
      },
    } as never);

    expect(converted.isArchived).toBe(true);
    expect(converted.archivedAt?.toISOString()).toBe("2026-05-06T09:31:00.000Z");
  });

  it("leaves active sessions unmarked", () => {
    const now = Date.parse("2026-05-06T09:32:00.000Z");

    const converted = convertSessionListItem({
      id: "ses_active",
      title: "Active chat",
      directory: "/workspace",
      time: { created: now - 1000, updated: now },
    } as never);

    expect(converted.isArchived).toBeUndefined();
    expect(converted.archivedAt).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run converter tests and verify failure**

Run:

```bash
pnpm --filter @teamclaw/app test:unit -- src/stores/__tests__/session-converters.test.ts
```

Expected: FAIL because `isArchived` and `archivedAt` are not populated.

- [ ] **Step 3: Add archive fields to the app Session type**

In `packages/app/src/stores/session-types.ts`, update `Session`:

```ts
export interface Session {
  id: string;
  title: string;
  messages: Message[];
  createdAt: Date;
  updatedAt: Date;
  messageCount?: number;
  directory?: string;
  parentID?: string;
  isArchived?: boolean;
  archivedAt?: Date;
}
```

- [ ] **Step 4: Update converters**

In `packages/app/src/stores/session-converters.ts`, add a helper near the converter functions:

```ts
function archiveMetadata(time: { archived?: number | null }): Pick<Session, "isArchived" | "archivedAt"> {
  if (!time.archived) return {};
  return {
    isArchived: true,
    archivedAt: new Date(time.archived),
  };
}
```

Then update both session converters:

```ts
export function convertSession(session: OpenCodeSession): Session {
  return {
    id: session.id,
    title: session.title || "New Chat",
    messages: [],
    createdAt: new Date(session.time.created),
    updatedAt: new Date(session.time.updated),
    directory: session.directory,
    parentID: session.parentID,
    ...archiveMetadata(session.time),
  };
}

export function convertSessionListItem(item: SessionListItem): Session {
  return {
    id: item.id,
    title: item.title || "New Chat",
    messages: [],
    createdAt: new Date(item.time.created),
    updatedAt: new Date(item.time.updated),
    directory: item.directory,
    parentID: item.parentID,
    ...archiveMetadata(item.time),
  };
}
```

- [ ] **Step 5: Extend the SDK compatibility wrapper**

In `packages/app/src/lib/opencode/sdk-client.ts`, add `restoreSession` to `OpenCodeClientCompat`:

```ts
restoreSession: typeof restoreSession
```

Add it to `buildCompat()` next to `archiveSession`:

```ts
archiveSession, restoreSession, updateSession, abortSession, getMessages,
```

Extend `listSessions` options and pass the SDK `archived` query:

```ts
export async function listSessions(options?: {
  directory?: string
  roots?: boolean
  archived?: boolean
}): Promise<SessionListItem[]> {
  const c = getRawSdkClient()
  const result = await c.session.list({
    directory: options?.directory || dir(),
    roots: options?.roots,
    archived: options?.archived,
  })
  return unwrap(result) as unknown as SessionListItem[]
}
```

Add the restore wrapper after `archiveSession`:

```ts
export async function restoreSession(id: string, directory?: string): Promise<void> {
  const c = getRawSdkClient()
  const result = await c.session.update({
    sessionID: id,
    directory: directory || dir(),
    time: { archived: null },
  } as unknown as Parameters<typeof c.session.update>[0])
  unwrap(result)
}
```

Use the cast because the generated SDK type allows `archived?: number`, while the OpenCode session model and database allow a nullable archived timestamp.

- [ ] **Step 6: Run focused tests and typecheck**

Run:

```bash
pnpm --filter @teamclaw/app test:unit -- src/stores/__tests__/session-converters.test.ts
pnpm --filter @teamclaw/app typecheck
```

Expected: converter tests PASS and typecheck PASS.

- [ ] **Step 7: Commit**

```bash
git add packages/app/src/lib/opencode/sdk-client.ts packages/app/src/stores/session-types.ts packages/app/src/stores/session-converters.ts packages/app/src/stores/__tests__/session-converters.test.ts
git commit -m "feat: add archived session metadata"
```

---

### Task 2: Archive-Specific Session Store Actions

**Files:**
- Modify: `packages/app/src/stores/session-types.ts`
- Modify: `packages/app/src/stores/session-loader.ts`
- Test: `packages/app/src/stores/__tests__/session-loader.test.ts`

- [ ] **Step 1: Write failing store tests**

Update the OpenCode client mock in `packages/app/src/stores/__tests__/session-loader.test.ts`:

```ts
const mockRestoreSession = vi.fn()
const mockGetSessionChildren = vi.fn()
```

Add `restoreSession` to the mocked client:

```ts
restoreSession: mockRestoreSession,
getSessionChildren: mockGetSessionChildren,
```

Add archive state to the `beforeEach` state object:

```ts
archivedSessions: [],
isLoadingArchivedSessions: false,
archivedSessionError: null,
viewingArchivedSessionId: null,
archivedSessionMessages: {},
```

Add these tests:

```ts
it("loadArchivedSessions loads only archived parent sessions sorted by archivedAt descending", async () => {
  const now = Date.now()
  mockListSessions.mockResolvedValue([
    { id: "active", title: "Active", time: { created: now, updated: now } },
    { id: "older-archived", title: "Older Archived", time: { created: now - 4000, updated: now - 3000, archived: now - 1000 } },
    { id: "newer-archived", title: "Newer Archived", time: { created: now - 4000, updated: now - 2000, archived: now } },
    { id: "child-archived", title: "Child Archived", parentID: "newer-archived", time: { created: now, updated: now, archived: now + 1 } },
  ])

  await actions.loadArchivedSessions("/workspace")

  expect(mockListSessions).toHaveBeenCalledWith({ directory: "/workspace", roots: true, archived: true })
  expect(state.archivedSessions.map((session: { id: string }) => session.id)).toEqual([
    "newer-archived",
    "older-archived",
  ])
  expect(state.isLoadingArchivedSessions).toBe(false)
  expect(state.archivedSessionError).toBeNull()
})

it("openArchivedSession loads archived messages without adding to normal sessions", async () => {
  const now = Date.now()
  state.archivedSessions = [
    { id: "archived-1", title: "Archived", messages: [], createdAt: new Date(now), updatedAt: new Date(now), isArchived: true, archivedAt: new Date(now) },
  ]
  state.sessions = []
  mockGetMessages.mockResolvedValue([
    {
      info: { id: "msg-1", sessionID: "archived-1", role: "user", time: { created: now } },
      parts: [{ id: "part-1", type: "text", text: "hello" }],
    },
  ])

  await actions.openArchivedSession("archived-1")

  expect(mockGetMessages).toHaveBeenCalledWith("archived-1")
  expect(state.viewingArchivedSessionId).toBe("archived-1")
  expect(state.archivedSessionMessages["archived-1"][0].content).toBe("hello")
  expect(state.sessions).toEqual([])
})

it("closeArchivedSession clears archived viewing state", () => {
  state.viewingArchivedSessionId = "archived-1"

  actions.closeArchivedSession()

  expect(state.viewingArchivedSessionId).toBeNull()
})

it("restoreSession clears archive state, reloads normal sessions, and activates restored session", async () => {
  const now = Date.now()
  state.currentWorkspacePath = "/workspace"
  state.archivedSessions = [
    { id: "archived-1", title: "Archived", messages: [], createdAt: new Date(now), updatedAt: new Date(now), directory: "/workspace", isArchived: true, archivedAt: new Date(now) },
  ]
  state.viewingArchivedSessionId = "archived-1"
  state.archivedSessionMessages = { "archived-1": [] }
  mockListSessions.mockResolvedValue([
    { id: "archived-1", title: "Archived", directory: "/workspace", time: { created: now, updated: now } },
  ])
  mockGetMessages.mockResolvedValue([])
  mockGetSession.mockResolvedValue({ id: "archived-1", title: "Archived", directory: "/workspace", time: { created: now, updated: now } })
  mockGetTodos.mockResolvedValue([])
  mockGetSessionDiff.mockResolvedValue([])
  mockGetSessionChildren.mockResolvedValue([])

  await actions.restoreSession("archived-1")

  expect(mockRestoreSession).toHaveBeenCalledWith("archived-1", "/workspace")
  expect(state.archivedSessions).toEqual([])
  expect(state.viewingArchivedSessionId).toBeNull()
  expect(state.archivedSessionMessages["archived-1"]).toBeUndefined()
  expect(state.activeSessionId).toBe("archived-1")
})
```

- [ ] **Step 2: Run store tests and verify failure**

Run:

```bash
pnpm --filter @teamclaw/app test:unit -- src/stores/__tests__/session-loader.test.ts
```

Expected: FAIL because the archive actions and state fields are missing.

- [ ] **Step 3: Add archive fields and actions to `SessionState`**

In `packages/app/src/stores/session-types.ts`, add these state fields after child-session fields:

```ts
archivedSessions: Session[];
isLoadingArchivedSessions: boolean;
archivedSessionError: string | null;
viewingArchivedSessionId: string | null;
archivedSessionMessages: Record<string, Message[]>;
```

Add these action signatures after `archiveSession`:

```ts
loadArchivedSessions: (workspacePath?: string) => Promise<void>;
openArchivedSession: (id: string) => Promise<void>;
closeArchivedSession: () => void;
restoreSession: (id: string) => Promise<void>;
```

- [ ] **Step 4: Initialize and reset archive state**

In `packages/app/src/stores/session-store.ts`, add initial values:

```ts
archivedSessions: [],
isLoadingArchivedSessions: false,
archivedSessionError: null,
viewingArchivedSessionId: null,
archivedSessionMessages: {},
```

In `resetSessions` in `packages/app/src/stores/session-loader.ts`, add:

```ts
archivedSessions: [],
isLoadingArchivedSessions: false,
archivedSessionError: null,
viewingArchivedSessionId: null,
archivedSessionMessages: {},
```

- [ ] **Step 5: Implement archive actions**

In `packages/app/src/stores/session-loader.ts`, inside `createLoaderActions`, add these actions after `archiveSession`:

```ts
loadArchivedSessions: async (workspacePath?: string) => {
  set({ isLoadingArchivedSessions: true, archivedSessionError: null });
  try {
    const client = getOpenCodeClient();
    const sessions = await client.listSessions(
      workspacePath
        ? { directory: workspacePath, roots: true, archived: true }
        : { roots: true, archived: true },
    );

    const archivedSessions = sessions
      .filter((session) => session.time?.archived && !session.parentID)
      .map(convertSessionListItem)
      .sort((a, b) => {
        const aTime = a.archivedAt?.getTime() ?? a.updatedAt.getTime();
        const bTime = b.archivedAt?.getTime() ?? b.updatedAt.getTime();
        return bTime - aTime;
      });

    set({
      archivedSessions,
      isLoadingArchivedSessions: false,
      archivedSessionError: null,
    });
  } catch (error) {
    set({
      archivedSessionError:
        error instanceof Error ? error.message : "Failed to load archived sessions",
      isLoadingArchivedSessions: false,
    });
  }
},

openArchivedSession: async (id: string) => {
  set({ isLoading: true, error: null });
  try {
    const client = getOpenCodeClient();
    const messages = await client.getMessages(id);
    const converted = messages.map(convertMessage);
    set((state) => ({
      viewingArchivedSessionId: id,
      archivedSessionMessages: {
        ...state.archivedSessionMessages,
        [id]: converted,
      },
      isLoading: false,
    }));
  } catch (error) {
    set({
      error:
        error instanceof Error ? error.message : "Failed to open archived session",
      isLoading: false,
    });
  }
},

closeArchivedSession: () => {
  set({ viewingArchivedSessionId: null });
},

restoreSession: async (id: string) => {
  try {
    const client = getOpenCodeClient();
    const archived = get().archivedSessions.find((session) => session.id === id);
    const directory = archived?.directory || get().currentWorkspacePath || undefined;
    await client.restoreSession(id, directory);

    set((state) => {
      const archivedSessionMessages = { ...state.archivedSessionMessages };
      delete archivedSessionMessages[id];
      return {
        archivedSessions: state.archivedSessions.filter((session) => session.id !== id),
        archivedSessionMessages,
        viewingArchivedSessionId:
          state.viewingArchivedSessionId === id ? null : state.viewingArchivedSessionId,
        archivedSessionError: null,
      };
    });

    await get().loadSessions(directory);
    await get().setActiveSession(id);
  } catch (error) {
    set({
      archivedSessionError:
        error instanceof Error ? error.message : "Failed to restore archived session",
    });
  }
},
```

- [ ] **Step 6: Clear archived viewing state when normal navigation starts**

In `createSession`, before adding the new session, include:

```ts
viewingArchivedSessionId: null,
```

In `setActiveSession`, when `id !== prevSessionId`, update the existing reset:

```ts
set({
  viewingChildSessionId: null,
  childSessionMessages: {},
  viewingArchivedSessionId: null,
});
```

- [ ] **Step 7: Run focused store tests**

Run:

```bash
pnpm --filter @teamclaw/app test:unit -- src/stores/__tests__/session-loader.test.ts
pnpm --filter @teamclaw/app typecheck
```

Expected: store tests PASS and typecheck PASS.

- [ ] **Step 8: Commit**

```bash
git add packages/app/src/stores/session-types.ts packages/app/src/stores/session-store.ts packages/app/src/stores/session-loader.ts packages/app/src/stores/__tests__/session-loader.test.ts
git commit -m "feat: add archived session store actions"
```

---

### Task 3: Search Dialog Active Archived All Modes

**Files:**
- Modify: `packages/app/src/components/app-sidebar.tsx`
- Modify: `packages/app/src/locales/en.json`
- Modify: `packages/app/src/locales/zh-CN.json`
- Test: `packages/app/src/components/__tests__/app-sidebar.test.tsx`

- [ ] **Step 1: Make command component mocks render their children**

In `packages/app/src/components/__tests__/app-sidebar.test.tsx`, replace the `@/components/ui/command` mock with:

```tsx
vi.mock('@/components/ui/command', () => ({
  CommandDialog: ({ children, open }: any) => open ? <div data-testid="session-search-dialog">{children}</div> : null,
  CommandInput: ({ placeholder }: any) => <input aria-label={placeholder} placeholder={placeholder} />,
  CommandList: ({ children, className }: any) => <div className={className}>{children}</div>,
  CommandEmpty: ({ children }: any) => <div>{children}</div>,
  CommandGroup: ({ children, heading }: any) => (
    <section aria-label={heading}>
      <h2>{heading}</h2>
      {children}
    </section>
  ),
  CommandItem: ({ children, onSelect, value }: any) => (
    <button type="button" data-value={value} onClick={() => onSelect?.(value)}>
      {children}
    </button>
  ),
}))
```

Add mocked store fields and actions:

```ts
archivedSessions: [] as unknown[],
isLoadingArchivedSessions: false,
archivedSessionError: null as string | null,
loadArchivedSessions: vi.fn(() => Promise.resolve()),
openArchivedSession: vi.fn(() => Promise.resolve()),
```

Add `switchToSession` to `uiStoreMocks`:

```ts
switchToSession: vi.fn(() => Promise.resolve()),
```

Update the `@/stores/ui` mock so component code can call `useUIStore.getState()`:

```tsx
vi.mock('@/stores/ui', () => ({
  useUIStore: Object.assign(
    (sel: (s: Record<string, unknown>) => unknown) =>
      sel(uiStoreMocks as unknown as Record<string, unknown>),
    { getState: () => uiStoreMocks },
  ),
}))
```

- [ ] **Step 2: Write failing search dialog tests**

Add these tests to `AppSidebar` tests:

```tsx
it("session search defaults to active sessions and can switch to archived results", async () => {
  sessionStoreMocks.archivedSessions = [
    {
      id: "archived-1",
      title: "Archived Todo Chat",
      updatedAt: new Date("2026-05-01T10:00:00.000Z"),
      archivedAt: new Date("2026-05-02T10:00:00.000Z"),
      isArchived: true,
      messages: [],
    },
  ]

  render(<AppSidebar />)

  fireEvent.click(screen.getByTitle("Search (⌘K)"))

  expect(screen.getByTestId("session-search-dialog")).toBeDefined()
  expect(screen.getByText("Session One")).toBeDefined()
  expect(screen.queryByText("Archived Todo Chat")).toBeNull()

  fireEvent.click(screen.getByRole("button", { name: "Archived" }))

  expect(sessionStoreMocks.loadArchivedSessions).toHaveBeenCalledWith("/workspace")
  expect(screen.getByText("Archived Todo Chat")).toBeDefined()
  expect(screen.queryByText("Session One")).toBeNull()
})

it("selecting an archived search result opens archived read-only mode", async () => {
  sessionStoreMocks.archivedSessions = [
    {
      id: "archived-1",
      title: "Archived Todo Chat",
      updatedAt: new Date("2026-05-01T10:00:00.000Z"),
      archivedAt: new Date("2026-05-02T10:00:00.000Z"),
      isArchived: true,
      messages: [],
    },
  ]

  render(<AppSidebar />)

  fireEvent.click(screen.getByTitle("Search (⌘K)"))
  fireEvent.click(screen.getByRole("button", { name: "Archived" }))
  fireEvent.click(screen.getByText("Archived Todo Chat"))

  expect(sessionStoreMocks.openArchivedSession).toHaveBeenCalledWith("archived-1")
  expect(uiStoreMocks.switchToSession).not.toHaveBeenCalledWith("archived-1")
})
```

- [ ] **Step 3: Run sidebar tests and verify failure**

Run:

```bash
pnpm --filter @teamclaw/app test:unit -- src/components/__tests__/app-sidebar.test.tsx
```

Expected: FAIL because the filter buttons and archived selection path do not exist.

- [ ] **Step 4: Implement search filter state and archived loading**

In `SessionSearchDialog` in `packages/app/src/components/app-sidebar.tsx`, add selectors:

```ts
const archivedSessions = useSessionStore(s => s.archivedSessions)
const isLoadingArchivedSessions = useSessionStore(s => s.isLoadingArchivedSessions)
const archivedSessionError = useSessionStore(s => s.archivedSessionError)
const loadArchivedSessions = useSessionStore(s => s.loadArchivedSessions)
const openArchivedSession = useSessionStore(s => s.openArchivedSession)
const workspacePath = useWorkspaceStore(s => s.workspacePath)
const [filter, setFilter] = React.useState<'active' | 'archived' | 'all'>('active')
```

Add loading effect:

```ts
React.useEffect(() => {
  if (!open) return
  if (filter === 'active') return
  void loadArchivedSessions(workspacePath || undefined)
}, [filter, loadArchivedSessions, open, workspacePath])
```

Build rendered sessions:

```ts
const visibleSessions = React.useMemo(() => {
  if (filter === 'archived') return archivedSessions
  if (filter === 'all') return [...sessions, ...archivedSessions]
  return sessions
}, [archivedSessions, filter, sessions])
```

Update selection:

```ts
const handleSelectSession = async (sessionId: string, isArchived?: boolean) => {
  if (isArchived) {
    await openArchivedSession(sessionId)
    onOpenChange(false)
    return
  }
  useUIStore.getState().switchToSession(sessionId)
  onOpenChange(false)
}
```

- [ ] **Step 5: Render filter buttons and archived result badges**

Inside `CommandDialog`, before `CommandList`, render:

```tsx
<div className="flex items-center gap-1 border-b px-3 py-2">
  {(['active', 'archived', 'all'] as const).map((item) => (
    <button
      key={item}
      type="button"
      onClick={() => setFilter(item)}
      className={cn(
        "rounded-md px-2 py-1 text-xs font-medium transition-colors",
        filter === item
          ? "bg-primary text-primary-foreground"
          : "text-muted-foreground hover:bg-muted hover:text-foreground",
      )}
    >
      {item === 'active'
        ? t('sidebar.searchActive', 'Active')
        : item === 'archived'
          ? t('sidebar.searchArchived', 'Archived')
          : t('sidebar.searchAll', 'All')}
    </button>
  ))}
</div>
```

Render `visibleSessions.map` instead of `sessions.map`, and pass archive state:

```tsx
<CommandItem
  key={`${session.isArchived ? 'archived' : 'active'}-${session.id}`}
  value={`${session.id} ${session.title} ${session.isArchived ? 'archived' : 'active'}`}
  onSelect={() => handleSelectSession(session.id, session.isArchived)}
>
  {session.isArchived ? (
    <Archive className="h-4 w-4 mr-3 text-muted-foreground shrink-0" />
  ) : (
    <MessageSquare className="h-4 w-4 mr-3 text-muted-foreground shrink-0" />
  )}
  <div className="flex flex-col flex-1 min-w-0">
    <span className="truncate font-medium">{session.title}</span>
    <span className="text-xs text-muted-foreground">
      {session.isArchived && session.archivedAt
        ? t('sidebar.archivedAt', 'Archived {{date}}', { date: formatDate(session.archivedAt) })
        : formatDate(session.updatedAt)}
    </span>
  </div>
  {session.isArchived ? (
    <span className="text-xs text-muted-foreground font-medium ml-2 shrink-0">
      {t('sidebar.archive', 'Archive')}
    </span>
  ) : activeSessionId === session.id ? (
    <span className="text-xs text-emerald-500 font-medium ml-2 shrink-0">{t('sidebar.active', 'Active')}</span>
  ) : null}
</CommandItem>
```

Render loading and error text inside `CommandList`:

```tsx
{isLoadingArchivedSessions && filter !== 'active' && (
  <div className="px-3 py-2 text-xs text-muted-foreground">
    {t('sidebar.loadingArchivedSessions', 'Loading archived sessions...')}
  </div>
)}
{archivedSessionError && filter !== 'active' && (
  <div className="px-3 py-2 text-xs text-destructive">
    {archivedSessionError}
  </div>
)}
```

- [ ] **Step 6: Add locale strings**

In `packages/app/src/locales/en.json`, under `sidebar`, add:

```json
"searchActive": "Active",
"searchArchived": "Archived",
"searchAll": "All",
"archivedAt": "Archived {{date}}",
"loadingArchivedSessions": "Loading archived sessions..."
```

In `packages/app/src/locales/zh-CN.json`, under `sidebar`, add:

```json
"searchActive": "活跃",
"searchArchived": "已归档",
"searchAll": "全部",
"archivedAt": "归档于 {{date}}",
"loadingArchivedSessions": "正在加载归档会话..."
```

- [ ] **Step 7: Run sidebar tests**

Run:

```bash
pnpm --filter @teamclaw/app test:unit -- src/components/__tests__/app-sidebar.test.tsx
pnpm --filter @teamclaw/app typecheck
```

Expected: sidebar tests PASS and typecheck PASS.

- [ ] **Step 8: Commit**

```bash
git add packages/app/src/components/app-sidebar.tsx packages/app/src/components/__tests__/app-sidebar.test.tsx packages/app/src/locales/en.json packages/app/src/locales/zh-CN.json
git commit -m "feat: add archived session search filter"
```

---

### Task 4: Archived Read-Only Chat View

**Files:**
- Modify: `packages/app/src/components/chat/ChatPanel.tsx`
- Modify: `packages/app/src/components/chat/__tests__/ChatPanel.test.tsx`
- Modify: `packages/app/src/locales/en.json`
- Modify: `packages/app/src/locales/zh-CN.json`

- [ ] **Step 1: Extend ChatPanel test mocks**

In `packages/app/src/components/chat/__tests__/ChatPanel.test.tsx`, add these fields to `sessionState`:

```ts
archivedSessions: [] as Array<{
  id: string;
  title: string;
  messages: unknown[];
  createdAt: Date;
  updatedAt: Date;
  isArchived?: boolean;
  archivedAt?: Date;
}>,
viewingArchivedSessionId: null as string | null,
archivedSessionMessages: {} as Record<string, unknown[]>,
archivedSessionError: null as string | null,
isLoadingArchivedSessions: false,
closeArchivedSession: vi.fn(),
restoreSession: vi.fn(() => Promise.resolve()),
```

In `beforeEach`, reset:

```ts
sessionState.archivedSessions = [];
sessionState.viewingArchivedSessionId = null;
sessionState.archivedSessionMessages = {};
sessionState.archivedSessionError = null;
sessionState.closeArchivedSession = vi.fn();
sessionState.restoreSession = vi.fn(() => Promise.resolve());
```

- [ ] **Step 2: Write failing read-only tests**

Add:

```tsx
it("renders archived messages in read-only mode", () => {
  sessionState.viewingArchivedSessionId = "archived-1";
  sessionState.archivedSessions = [
    {
      id: "archived-1",
      title: "Archived Todo Chat",
      messages: [],
      createdAt: new Date("2026-05-01T10:00:00.000Z"),
      updatedAt: new Date("2026-05-01T11:00:00.000Z"),
      isArchived: true,
      archivedAt: new Date("2026-05-02T10:00:00.000Z"),
    },
  ];
  sessionState.archivedSessionMessages = {
    "archived-1": [
      {
        id: "msg-1",
        sessionId: "archived-1",
        role: "user",
        content: "Archived hello",
        parts: [],
        timestamp: new Date("2026-05-01T10:05:00.000Z"),
      },
    ],
  };

  const { container } = render(<ChatPanel />);

  expect(container.textContent).toContain("Archived Todo Chat");
  expect(container.textContent).toContain("Archived hello");
  expect(container.textContent).toContain("Restore");
  expect(container.textContent).toContain("Restore this session to continue chatting");
})

it("restores archived session from the read-only bar", async () => {
  sessionState.viewingArchivedSessionId = "archived-1";
  sessionState.archivedSessions = [
    {
      id: "archived-1",
      title: "Archived Todo Chat",
      messages: [],
      createdAt: new Date(),
      updatedAt: new Date(),
      isArchived: true,
      archivedAt: new Date(),
    },
  ];

  const { findByText } = render(<ChatPanel />);

  fireEvent.click(await findByText("Restore"));

  expect(sessionState.restoreSession).toHaveBeenCalledWith("archived-1");
})
```

Add `fireEvent` import:

```ts
import { fireEvent, render } from '@testing-library/react';
```

- [ ] **Step 3: Run ChatPanel tests and verify failure**

Run:

```bash
pnpm --filter @teamclaw/app test:unit -- src/components/chat/__tests__/ChatPanel.test.tsx
```

Expected: FAIL because archived read-only mode is not rendered.

- [ ] **Step 4: Add archived selectors and derived data**

In `packages/app/src/components/chat/ChatPanel.tsx`, import `Archive`:

```ts
import { AlertCircle, Archive, ArrowLeft, Bot, Loader2, RefreshCw, X } from "lucide-react";
```

Add selectors near the child-session selectors:

```ts
const viewingArchivedSessionId = useSessionStore(s => s.viewingArchivedSessionId);
const archivedSessionMessages = useSessionStore(s =>
  s.viewingArchivedSessionId
    ? (s.archivedSessionMessages[s.viewingArchivedSessionId] || EMPTY_MESSAGES)
    : EMPTY_MESSAGES
);
const archivedSession = useSessionStore(s =>
  s.viewingArchivedSessionId
    ? s.archivedSessions.find((session) => session.id === s.viewingArchivedSessionId)
    : undefined
);
const isViewingArchived = !!viewingArchivedSessionId;
```

Add actions:

```ts
const closeArchivedSession = acts.closeArchivedSession;
const restoreSession = acts.restoreSession;
```

Update read-only exclusions:

```ts
if (isViewingChild || isViewingArchived) return false;
```

Use that in `showInlineTodo` and `activeInputQuestion`.

- [ ] **Step 5: Render archived read-only bar and messages**

Before the child session bar, render:

```tsx
{isViewingArchived && (
  <div className="flex items-center gap-2 border-b border-border bg-muted/30 px-3 py-2">
    <button
      type="button"
      onClick={() => closeArchivedSession()}
      className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors"
    >
      <ArrowLeft size={14} />
      <span>{t("chat.backToActiveSession", "Back to active session")}</span>
    </button>
    <div className="min-w-0 flex flex-1 items-center gap-1.5 text-xs text-muted-foreground">
      <Archive size={12} />
      <span className="truncate">
        {archivedSession?.title || t("chat.archivedSession", "Archived session")}
      </span>
    </div>
    <Button
      type="button"
      size="sm"
      variant="outline"
      className="h-7 gap-1.5 px-2 text-xs"
      onClick={() => viewingArchivedSessionId && void restoreSession(viewingArchivedSessionId)}
    >
      <RefreshCw className="h-3 w-3" />
      {t("chat.restoreSession", "Restore")}
    </Button>
  </div>
)}
```

Update message list rendering:

```tsx
{isViewingArchived ? (
  <MessageList
    ref={messageListRef}
    messages={archivedSessionMessages}
    activeSessionId={viewingArchivedSessionId}
    isStreaming={false}
    streamingMessageId={null}
    compact={compact}
  />
) : isViewingChild ? (
  ...
) : (
  ...
)}
```

Update opacity:

```tsx
style={{ opacity: isViewingChild || isViewingArchived ? 1 : sessionFadeOpacity }}
```

Replace the input conditional with archived read-only footer first:

```tsx
{isViewingArchived ? (
  <div className="border-t border-border bg-background px-3 py-3">
    <div className="rounded-lg border border-dashed bg-muted/30 px-3 py-2 text-sm text-muted-foreground">
      {t("chat.restoreArchivedHint", "Restore this session to continue chatting")}
    </div>
  </div>
) : !isViewingChild && (
  ...
)}
```

- [ ] **Step 6: Add locale strings**

In `packages/app/src/locales/en.json`, under `chat`, add:

```json
"backToActiveSession": "Back to active session",
"archivedSession": "Archived session",
"restoreSession": "Restore",
"restoreArchivedHint": "Restore this session to continue chatting"
```

In `packages/app/src/locales/zh-CN.json`, under `chat`, add:

```json
"backToActiveSession": "返回活跃会话",
"archivedSession": "归档会话",
"restoreSession": "恢复",
"restoreArchivedHint": "恢复此会话后可继续聊天"
```

- [ ] **Step 7: Run ChatPanel tests**

Run:

```bash
pnpm --filter @teamclaw/app test:unit -- src/components/chat/__tests__/ChatPanel.test.tsx
pnpm --filter @teamclaw/app typecheck
```

Expected: ChatPanel tests PASS and typecheck PASS.

- [ ] **Step 8: Commit**

```bash
git add packages/app/src/components/chat/ChatPanel.tsx packages/app/src/components/chat/__tests__/ChatPanel.test.tsx packages/app/src/locales/en.json packages/app/src/locales/zh-CN.json
git commit -m "feat: show archived sessions read-only"
```

---

### Task 5: Integration Verification And Polish

**Files:**
- No planned edits. If verification exposes a failure in a touched file, fix only that concrete failure in the file that caused it.

- [ ] **Step 1: Run all focused tests**

Run:

```bash
pnpm --filter @teamclaw/app test:unit -- src/stores/__tests__/session-converters.test.ts src/stores/__tests__/session-loader.test.ts src/components/__tests__/app-sidebar.test.tsx src/components/chat/__tests__/ChatPanel.test.tsx
```

Expected: PASS.

- [ ] **Step 2: Run project typecheck**

Run:

```bash
pnpm --filter @teamclaw/app typecheck
```

Expected: PASS.

- [ ] **Step 3: Run lint on changed app files**

Run:

```bash
pnpm --filter @teamclaw/app lint
```

Expected: PASS or only pre-existing lint failures unrelated to the touched files. If lint reports touched-file errors, fix those exact errors and rerun lint.

- [ ] **Step 4: Manual browser verification**

Start the dev server:

```bash
pnpm dev
```

Open the app in the browser or Tauri dev shell. Verify:

1. Normal sidebar still shows only active sessions.
2. Search Sessions opens with Active selected.
3. Archived tab loads archived sessions and labels them.
4. Selecting an archived result opens a read-only message view.
5. The input area is replaced by the restore hint.
6. Restore returns the session to the normal list and opens it as active.

- [ ] **Step 5: Final commit if verification required fixes**

If Step 3 or Step 4 required code changes:

```bash
git add packages/app/src/lib/opencode/sdk-client.ts packages/app/src/stores/session-types.ts packages/app/src/stores/session-converters.ts packages/app/src/stores/session-store.ts packages/app/src/stores/session-loader.ts packages/app/src/components/app-sidebar.tsx packages/app/src/components/chat/ChatPanel.tsx packages/app/src/locales/en.json packages/app/src/locales/zh-CN.json packages/app/src/stores/__tests__/session-converters.test.ts packages/app/src/stores/__tests__/session-loader.test.ts packages/app/src/components/__tests__/app-sidebar.test.tsx packages/app/src/components/chat/__tests__/ChatPanel.test.tsx
git commit -m "fix: polish archived session search"
```

Expected: a final fix commit exists only if verification found issues after the feature commits.

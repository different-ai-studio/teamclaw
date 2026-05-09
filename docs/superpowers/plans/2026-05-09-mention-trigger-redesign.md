# Mention Trigger Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Swap chat composer triggers in ChatPanel — `#` becomes the resource (file) picker; `@` becomes a session-participant picker (members + agents). Members render as inline `@Name` plain text; agents render as removable chips above the composer. Send populates `SessionMessageEnvelope.mentionActorIds` + `messages.metadata.mention_actor_ids`.

**Architecture:** Reuse existing infrastructure — `prompt-input.tsx` already has `onHashTrigger`/`onHashClose` plumbing (line 397-431, currently unconsumed). `createInsertMention` (line 140) already inserts plain `@Name` text and pushes to a `mentions` state in `PromptInputContext`. The `MentionPopover` component exists but is dead code today; we'll re-source it from `session_participants × actors` and add an agent code path. Agent state (`attachedAgents`) lifts up to `ChatPanel` next to `attachedFiles`, propagated to `ChatInputArea` via props.

**Tech Stack:** TypeScript, React 19, Tailwind 4, Zustand, Supabase JS, Vitest + @testing-library/react. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-05-09-mention-trigger-redesign-design.md` (commit `865e17e7`).

**Spec deviation noted up front:** The spec proposed a `@{member:UUID:DisplayName}` chip-token format and a new regex in `editable-with-file-chips.tsx`. During plan-writing we found `prompt-input.tsx` already inserts members as plain `@Name` text and tracks IDs in a `PromptInputContext.mentions` state — exactly amux iOS's behavior and simpler. The plan uses that path; the user-visible result and wire format are identical. The spec's "added regex" task is replaced by "consume existing `mentions` state on send".

---

## File map (8 files touched, 1 new)

| File | Disposition | Why |
|---|---|---|
| `packages/app/src/locales/en.json` | Modify | Update `chat.inputPlaceholderMention`; add 3 new keys |
| `packages/app/src/locales/zh-CN.json` | Modify | Same as en |
| `packages/app/src/packages/ai/prompt-input-insert-hooks.ts` | Modify | Add `createInsertHashFile` (copy of `createInsertFileMention` but using `hashStartRef`); add `createInsertAgentMention` (strips `@query`, no text insert) |
| `packages/app/src/components/chat/MentionPopover.tsx` | Modify | Replace `useContactsStore` with `session_participants × actors` query; render member/agent split with icons; add `onSelectAgent` callback |
| `packages/app/src/components/chat/AgentChipBar.tsx` | **Create** | Renders attached agents above composer with × remove |
| `packages/app/src/components/chat/ChatInputArea.tsx` | Modify | Wire `FileMentionPopover` to `#` (was `@`); wire `MentionPopover` to `@`; add `attachedAgents` props + render `AgentChipBar`; placeholder copy via i18n |
| `packages/app/src/components/chat/ChatPanel.tsx` | Modify | Own `attachedAgents` state next to `attachedFiles`; on send, pull `mentions` from PromptInputContext + `attachedAgents`, dedup, populate `SessionMessageEnvelope.mentionActorIds` and `messages.metadata.mention_actor_ids`; clear `attachedAgents` after send |
| `packages/app/src/components/chat/__tests__/MentionPopover.test.tsx` | **Create** | Cover new data source + member/agent split + selection callbacks |

---

## Pre-flight

- [ ] **Step 0a: Branch check**

```bash
git rev-parse --abbrev-ref HEAD
```
Expected: `v2/amuxd-architecture` (this plan was authored on this branch). If on a different branch, stop and confer.

- [ ] **Step 0b: Tests baseline**

```bash
pnpm test:unit -- --run packages/app/src/components/chat
```
Expected: existing chat tests pass. Record any pre-existing failures so we don't blame the plan for them later.

- [ ] **Step 0c: Typecheck baseline**

```bash
pnpm typecheck
```
Expected: zero errors. Record output.

---

## Task 1: i18n keys

**Files:**
- Modify: `packages/app/src/locales/en.json`
- Modify: `packages/app/src/locales/zh-CN.json`

- [ ] **Step 1: Locate the chat block in en.json**

```bash
grep -n '"inputPlaceholderMention"' packages/app/src/locales/en.json
```
Note the line number. There should be a `"chat": { ... }` object containing it.

- [ ] **Step 2: Update en.json**

Replace the line `"inputPlaceholderMention": "Type @ to reference files..."` with:

```json
    "inputPlaceholderMention": "Mention with @, reference files with #...",
    "mentionPopoverTitle": "Mention people or agents",
    "mentionEmptyState": "No one to mention in this session yet",
    "resourcePopoverTitle": "Reference a file",
```

(Keep trailing comma rules of surrounding JSON intact — if `inputPlaceholderMention` was the last key in `chat`, the new `resourcePopoverTitle` becomes the last and drops its trailing comma.)

- [ ] **Step 3: Update zh-CN.json**

Replace `"inputPlaceholderMention": "输入 @ 引用文件..."` with:

```json
    "inputPlaceholderMention": "输入 @ 提及人或 agent，# 引用文件...",
    "mentionPopoverTitle": "提及人或 agent",
    "mentionEmptyState": "当前会话还没有可 @ 的人或 agent",
    "resourcePopoverTitle": "引用文件",
```

- [ ] **Step 4: Verify JSON is valid**

```bash
node -e "JSON.parse(require('fs').readFileSync('packages/app/src/locales/en.json','utf8')); JSON.parse(require('fs').readFileSync('packages/app/src/locales/zh-CN.json','utf8')); console.log('ok')"
```
Expected: `ok`

- [ ] **Step 5: Commit**

```bash
git add packages/app/src/locales/en.json packages/app/src/locales/zh-CN.json
git commit -m "i18n(chat): add mention/resource popover keys"
```

---

## Task 2: `createInsertHashFile` helper

`createInsertFileMention` reads `mentionStartRef` and matches `@{...}`. We need a parallel that reads `hashStartRef` and matches `#`. Don't refactor the original — leave it for now to avoid touching unrelated callers; we'll remove its `@`-trigger wiring in Task 4.

**Files:**
- Modify: `packages/app/src/packages/ai/prompt-input-insert-hooks.ts`
- Test: `packages/app/src/packages/ai/__tests__/prompt-input-insert-hooks.test.ts` (create if absent — check first with `ls packages/app/src/packages/ai/__tests__/`)

- [ ] **Step 1: Write the failing test**

If `prompt-input-insert-hooks.test.ts` doesn't exist, create it. Add this test:

```ts
import { describe, it, expect, vi } from 'vitest'
import { createInsertHashFile } from '../prompt-input-insert-hooks'

function makeContext(initialText: string, hashAt: number) {
  let text = initialText
  const setText = vi.fn((next: string) => { text = next })
  const onHashClose = vi.fn()
  const hashStartRef = { current: hashAt as number | null }
  const textareaRef = { current: null as HTMLDivElement | null }
  return {
    ctx: {
      text: () => text,
      setText,
      onHashClose,
      hashStartRef,
      textareaRef,
    },
    spies: { setText, onHashClose, hashStartRef },
  }
}

describe('createInsertHashFile', () => {
  it('replaces #query with @{path} and clears hashStartRef', () => {
    const initial = 'Hello #foo'
    const { ctx, spies } = makeContext(initial, 6)
    const insert = createInsertHashFile({
      get text() { return ctx.text() },
      setText: ctx.setText,
      onHashClose: ctx.onHashClose,
      textareaRef: ctx.textareaRef,
      hashStartRef: ctx.hashStartRef,
    } as any)
    insert('src/main.ts')
    expect(spies.setText).toHaveBeenCalledWith('Hello @{src/main.ts} ')
    expect(spies.hashStartRef.current).toBeNull()
    expect(spies.onHashClose).toHaveBeenCalledTimes(1)
  })
})
```

- [ ] **Step 2: Run the test, expect failure**

```bash
pnpm test:unit -- --run packages/app/src/packages/ai/__tests__/prompt-input-insert-hooks.test.ts
```
Expected: FAIL — `createInsertHashFile is not a function`.

- [ ] **Step 3: Implement `createInsertHashFile`**

In `packages/app/src/packages/ai/prompt-input-insert-hooks.ts`, append after `createInsertFileMention`:

```ts
export function createInsertHashFile(context: PromptInputContextValue) {
  const { text, setText, onHashClose, textareaRef, hashStartRef } = context

  return (filePath: string) => {
    let lastValidHashIndex = -1
    for (let i = text.length - 1; i >= 0; i--) {
      if (text[i] === '#') {
        lastValidHashIndex = i
        break
      }
    }

    if (lastValidHashIndex !== -1) {
      const beforeHash = text.slice(0, lastValidHashIndex)
      const afterHash = text.slice(lastValidHashIndex)
      const queryEndMatch = afterHash.match(/^#[^\s]*/)
      const queryEnd = queryEndMatch ? queryEndMatch[0].length : 1
      const afterQuery = text.slice(lastValidHashIndex + queryEnd)

      // Wire format keeps the @{path} chip token (existing serializer in
      // ChatPanel/editable-with-file-chips already handles it).
      const mentionText = `@{${filePath}} `
      const newText = `${beforeHash}${mentionText}${afterQuery}`
      setText(newText)

      setTimeout(() => {
        const editable = textareaRef.current
        if (editable) {
          editable.focus()
          const targetPos = beforeHash.length + mentionText.length
          setCursorAtPosition(editable, targetPos)
        }
      }, 10)
    }

    hashStartRef.current = null
    onHashClose?.()
  }
}
```

The `setCursorAtPosition` helper is already imported at the top of the file (it's used by the other helpers).

- [ ] **Step 4: Run the test again, expect pass**

```bash
pnpm test:unit -- --run packages/app/src/packages/ai/__tests__/prompt-input-insert-hooks.test.ts
```
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/app/src/packages/ai/prompt-input-insert-hooks.ts packages/app/src/packages/ai/__tests__/prompt-input-insert-hooks.test.ts
git commit -m "feat(prompt-input): add createInsertHashFile for # trigger"
```

---

## Task 3: `createInsertAgentMention` helper

For agents we DON'T insert anything in the text — we strip the `@query` and emit the actor to the parent so it can render an above-composer chip.

**Files:**
- Modify: `packages/app/src/packages/ai/prompt-input-insert-hooks.ts`
- Test: `packages/app/src/packages/ai/__tests__/prompt-input-insert-hooks.test.ts`

- [ ] **Step 1: Add failing test**

Append to `prompt-input-insert-hooks.test.ts`:

```ts
import { createInsertAgentMention } from '../prompt-input-insert-hooks'

describe('createInsertAgentMention', () => {
  it('strips @query from text without inserting anything and calls onAttachAgent', () => {
    let text = 'Hi @qu'
    const setText = vi.fn((next: string) => { text = next })
    const onMentionClose = vi.fn()
    const onAttachAgent = vi.fn()
    const mentionStartRef = { current: 3 as number | null }
    const insert = createInsertAgentMention({
      get text() { return text },
      setText,
      onMentionClose,
      mentionStartRef,
      textareaRef: { current: null },
    } as any, onAttachAgent)
    insert({ id: 'actor-1', displayName: 'Reviewer Agent' })
    expect(setText).toHaveBeenCalledWith('Hi ')
    expect(onAttachAgent).toHaveBeenCalledWith({ id: 'actor-1', displayName: 'Reviewer Agent' })
    expect(mentionStartRef.current).toBeNull()
    expect(onMentionClose).toHaveBeenCalledTimes(1)
  })
})
```

- [ ] **Step 2: Run, expect failure**

```bash
pnpm test:unit -- --run packages/app/src/packages/ai/__tests__/prompt-input-insert-hooks.test.ts
```
Expected: FAIL — `createInsertAgentMention is not a function`.

- [ ] **Step 3: Implement**

In `packages/app/src/packages/ai/prompt-input-insert-hooks.ts`, append:

```ts
export type AttachedAgent = { id: string; displayName: string }

export function createInsertAgentMention(
  context: PromptInputContextValue,
  onAttachAgent: (agent: AttachedAgent) => void,
) {
  const { text, setText, onMentionClose, textareaRef, mentionStartRef } = context

  return (agent: AttachedAgent) => {
    let lastValidAtIndex = -1
    for (let i = text.length - 1; i >= 0; i--) {
      if (text[i] === '@') {
        const afterAt = text.slice(i + 1)
        const isFileMention = afterAt.match(/^\{[^}]*\}/)
        if (!isFileMention) {
          lastValidAtIndex = i
          break
        }
      }
    }

    if (lastValidAtIndex !== -1) {
      const beforeAt = text.slice(0, lastValidAtIndex)
      const afterAt = text.slice(lastValidAtIndex)
      const queryEndMatch = afterAt.match(/^@[^\s]*/)
      const queryEnd = queryEndMatch ? queryEndMatch[0].length : 1
      const afterQuery = text.slice(lastValidAtIndex + queryEnd).trimStart()
      setText(`${beforeAt}${afterQuery}`)

      setTimeout(() => {
        const editable = textareaRef.current
        if (editable) {
          editable.focus()
          setCursorAtPosition(editable, beforeAt.length)
        }
      }, 10)
    }

    onAttachAgent(agent)
    mentionStartRef.current = null
    onMentionClose?.()
  }
}
```

- [ ] **Step 4: Run, expect pass**

```bash
pnpm test:unit -- --run packages/app/src/packages/ai/__tests__/prompt-input-insert-hooks.test.ts
```
Expected: both tests PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/app/src/packages/ai/prompt-input-insert-hooks.ts packages/app/src/packages/ai/__tests__/prompt-input-insert-hooks.test.ts
git commit -m "feat(prompt-input): add createInsertAgentMention helper"
```

---

## Task 4: Re-source `MentionPopover` to session participants

Drop `useContactsStore`. Query `session_participants × actors` for the current session id from `useSessionStore`. Render member and agent groups with distinct icons. Add `onSelectAgent` callback alongside the existing `onSelect` (rename `onSelect` → `onSelectMember` for clarity).

**Files:**
- Modify: `packages/app/src/components/chat/MentionPopover.tsx`
- Test: `packages/app/src/components/chat/__tests__/MentionPopover.test.tsx` (create)

- [ ] **Step 1: Write the failing test**

Create `packages/app/src/components/chat/__tests__/MentionPopover.test.tsx`:

```tsx
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MentionPopover } from '../MentionPopover'

// ── Mocks ────────────────────────────────────────────────────────
const mockSelect = vi.fn()
const supabaseFrom = vi.fn()
vi.mock('@/lib/supabase-client', () => ({
  supabase: { from: (...args: unknown[]) => supabaseFrom(...args) },
}))
vi.mock('@/stores/session-store', () => ({
  useSessionStore: (sel: any) => sel({ currentSessionId: 'sess-1' }),
}))
vi.mock('@/stores/auth-store', () => ({
  useAuthStore: (sel: any) => sel({ session: { user: { id: 'user-1' } } }),
}))
// i18n shim — return the key as the value
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (k: string, fallback: string) => fallback }),
}))

beforeEach(() => {
  mockSelect.mockReset()
  supabaseFrom.mockReset()
})

function mockParticipants(rows: Array<{ id: string; actor_type: 'member' | 'agent'; display_name: string }>) {
  supabaseFrom.mockImplementation(() => ({
    select: () => ({
      eq: () => Promise.resolve({
        data: rows.map(r => ({ actor_id: r.id, actors: r })),
        error: null,
      }),
    }),
  }))
}

describe('MentionPopover', () => {
  it('renders member and agent groups with icons after fetching session_participants', async () => {
    mockParticipants([
      { id: 'm-1', actor_type: 'member', display_name: 'Alice' },
      { id: 'a-1', actor_type: 'agent', display_name: 'Reviewer Bot' },
    ])
    render(
      <MentionPopover
        open={true}
        onOpenChange={() => {}}
        searchQuery=""
        onSearchChange={() => {}}
        onSelectMember={mockSelect}
        onSelectAgent={vi.fn()}
      />,
    )
    await waitFor(() => expect(screen.getByText('Alice')).toBeInTheDocument())
    expect(screen.getByText('Reviewer Bot')).toBeInTheDocument()
    // groups present
    expect(screen.getByText(/members/i)).toBeInTheDocument()
    expect(screen.getByText(/agents/i)).toBeInTheDocument()
  })

  it('calls onSelectMember when a member is clicked, onSelectAgent when an agent is clicked', async () => {
    const onSelectMember = vi.fn()
    const onSelectAgent = vi.fn()
    mockParticipants([
      { id: 'm-1', actor_type: 'member', display_name: 'Alice' },
      { id: 'a-1', actor_type: 'agent', display_name: 'Reviewer Bot' },
    ])
    const user = userEvent.setup()
    render(
      <MentionPopover
        open={true}
        onOpenChange={() => {}}
        searchQuery=""
        onSearchChange={() => {}}
        onSelectMember={onSelectMember}
        onSelectAgent={onSelectAgent}
      />,
    )
    await waitFor(() => screen.getByText('Alice'))
    await user.click(screen.getByText('Alice'))
    expect(onSelectMember).toHaveBeenCalledWith({ id: 'm-1', name: 'Alice' })
    await user.click(screen.getByText('Reviewer Bot'))
    expect(onSelectAgent).toHaveBeenCalledWith({ id: 'a-1', displayName: 'Reviewer Bot' })
  })

  it('shows empty state when participants list is empty', async () => {
    mockParticipants([])
    render(
      <MentionPopover
        open={true}
        onOpenChange={() => {}}
        searchQuery=""
        onSearchChange={() => {}}
        onSelectMember={vi.fn()}
        onSelectAgent={vi.fn()}
      />,
    )
    await waitFor(() => expect(screen.getByText(/no one to mention/i)).toBeInTheDocument())
  })
})
```

- [ ] **Step 2: Run, expect failure**

```bash
pnpm test:unit -- --run packages/app/src/components/chat/__tests__/MentionPopover.test.tsx
```
Expected: FAIL — old `MentionPopover` accepts `onSelect`, not `onSelectMember`/`onSelectAgent`; uses `useContactsStore`, not Supabase.

- [ ] **Step 3: Rewrite `MentionPopover.tsx`**

Replace the file's contents with:

```tsx
import * as React from 'react'
import { User, Sparkles, Search } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandItem,
  CommandList,
} from '@/components/ui/command'
import { supabase } from '@/lib/supabase-client'
import { useSessionStore } from '@/stores/session-store'
import { type MentionedPerson } from '@/packages/ai/prompt-input'
import type { AttachedAgent } from '@/packages/ai/prompt-input-insert-hooks'

export type { MentionedPerson }

interface MentionPopoverProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  searchQuery: string
  onSearchChange: (query: string) => void
  onSelectMember: (person: MentionedPerson) => void
  onSelectAgent: (agent: AttachedAgent) => void
}

type ParticipantRow = {
  id: string
  actor_type: 'member' | 'agent'
  display_name: string
}

// 30s in-memory cache keyed by session id
const cache = new Map<string, { fetchedAt: number; rows: ParticipantRow[] }>()
const CACHE_TTL_MS = 30_000

async function fetchParticipants(sessionId: string): Promise<ParticipantRow[]> {
  const hit = cache.get(sessionId)
  if (hit && Date.now() - hit.fetchedAt < CACHE_TTL_MS) return hit.rows
  const { data, error } = await supabase
    .from('session_participants')
    .select('actor_id, actors!inner(id, actor_type, display_name)')
    .eq('session_id', sessionId)
  if (error || !data) {
    return []
  }
  const rows: ParticipantRow[] = data
    .map((d: any) => d.actors as ParticipantRow)
    .filter((a): a is ParticipantRow => !!a)
  cache.set(sessionId, { fetchedAt: Date.now(), rows })
  return rows
}

function filter(rows: ParticipantRow[], query: string): ParticipantRow[] {
  if (!query) return rows
  const q = query.toLowerCase()
  return rows.filter(r => r.display_name.toLowerCase().includes(q))
}

export function MentionPopover({
  open,
  onOpenChange,
  searchQuery,
  onSearchChange,
  onSelectMember,
  onSelectAgent,
}: MentionPopoverProps) {
  const { t } = useTranslation()
  const sessionId = useSessionStore(s => s.currentSessionId)
  const [rows, setRows] = React.useState<ParticipantRow[]>([])
  const [loading, setLoading] = React.useState(false)
  const [error, setError] = React.useState(false)
  const inputRef = React.useRef<HTMLInputElement>(null)

  React.useEffect(() => {
    if (!open || !sessionId) return
    let cancelled = false
    setLoading(true)
    setError(false)
    fetchParticipants(sessionId)
      .then(r => { if (!cancelled) setRows(r) })
      .catch(() => { if (!cancelled) setError(true) })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [open, sessionId])

  React.useEffect(() => {
    if (open) setTimeout(() => inputRef.current?.focus(), 50)
  }, [open])

  if (!open) return null

  const filtered = filter(rows, searchQuery)
  const members = filtered.filter(r => r.actor_type === 'member')
  const agents = filtered.filter(r => r.actor_type === 'agent')
  const isEmpty = !loading && !error && filtered.length === 0

  return (
    <div
      className="absolute bottom-full left-0 mb-2 w-80 rounded-lg border bg-popover shadow-lg z-50"
      onKeyDown={(e) => { if (e.key === 'Escape') { e.preventDefault(); onOpenChange(false) } }}
    >
      <Command shouldFilter={false}>
        <div className="flex items-center gap-2 border-b px-3 py-2">
          <Search className="h-4 w-4 text-muted-foreground shrink-0" />
          <input
            ref={inputRef}
            type="text"
            value={searchQuery}
            onChange={(e) => onSearchChange(e.target.value)}
            placeholder={t('chat.mentionPopoverTitle', 'Mention people or agents')}
            className="flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
          />
        </div>
        <CommandList className="max-h-60 overflow-y-auto">
          {loading && (
            <div className="py-4 text-center text-sm text-muted-foreground">…</div>
          )}
          {error && (
            <CommandEmpty>{t('chat.mentionPopoverError', 'Failed to load participants')}</CommandEmpty>
          )}
          {isEmpty && (
            <CommandEmpty>{t('chat.mentionEmptyState', 'No one to mention in this session yet')}</CommandEmpty>
          )}
          {members.length > 0 && (
            <CommandGroup heading="Members">
              {members.map(m => (
                <CommandItem
                  key={m.id}
                  value={`m:${m.id}`}
                  onSelect={() => {
                    onSelectMember({ id: m.id, name: m.display_name })
                    onOpenChange(false)
                  }}
                  className="flex items-center gap-2 cursor-pointer"
                >
                  <User className="h-4 w-4 text-muted-foreground shrink-0" />
                  <span className="text-sm font-medium truncate">{m.display_name}</span>
                </CommandItem>
              ))}
            </CommandGroup>
          )}
          {agents.length > 0 && (
            <CommandGroup heading="Agents">
              {agents.map(a => (
                <CommandItem
                  key={a.id}
                  value={`a:${a.id}`}
                  onSelect={() => {
                    onSelectAgent({ id: a.id, displayName: a.display_name })
                    onOpenChange(false)
                  }}
                  className="flex items-center gap-2 cursor-pointer"
                >
                  <Sparkles className="h-4 w-4 text-orange-500 shrink-0" />
                  <span className="text-sm font-medium truncate">{a.display_name}</span>
                </CommandItem>
              ))}
            </CommandGroup>
          )}
        </CommandList>
      </Command>
    </div>
  )
}
```

Note: the existing `MentionBadge` export at the end of the old file is unused (verified by grep). Drop it.

- [ ] **Step 4: Run tests, expect pass**

```bash
pnpm test:unit -- --run packages/app/src/components/chat/__tests__/MentionPopover.test.tsx
```
Expected: all 3 tests PASS.

- [ ] **Step 5: Run unit suite to catch unintended fallout**

```bash
pnpm test:unit -- --run
```
Expected: no new failures vs baseline. If `useContactsStore` mocks elsewhere broke, check whether those tests reference `MentionPopover` — they shouldn't, since it was unwired.

- [ ] **Step 6: Commit**

```bash
git add packages/app/src/components/chat/MentionPopover.tsx packages/app/src/components/chat/__tests__/MentionPopover.test.tsx
git commit -m "feat(chat): re-source MentionPopover from session_participants × actors"
```

---

## Task 5: `AgentChipBar` component

**Files:**
- Create: `packages/app/src/components/chat/AgentChipBar.tsx`
- Test: `packages/app/src/components/chat/__tests__/AgentChipBar.test.tsx`

- [ ] **Step 1: Write failing test**

Create `packages/app/src/components/chat/__tests__/AgentChipBar.test.tsx`:

```tsx
import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { AgentChipBar } from '../AgentChipBar'

describe('AgentChipBar', () => {
  it('renders nothing when list is empty', () => {
    const { container } = render(<AgentChipBar agents={[]} onRemove={() => {}} />)
    expect(container.firstChild).toBeNull()
  })
  it('renders one chip per agent and calls onRemove with id', async () => {
    const onRemove = vi.fn()
    const user = userEvent.setup()
    render(
      <AgentChipBar
        agents={[
          { id: 'a-1', displayName: 'Reviewer' },
          { id: 'a-2', displayName: 'Planner' },
        ]}
        onRemove={onRemove}
      />,
    )
    expect(screen.getByText('Reviewer')).toBeInTheDocument()
    expect(screen.getByText('Planner')).toBeInTheDocument()
    const removeButtons = screen.getAllByRole('button', { name: /remove/i })
    expect(removeButtons).toHaveLength(2)
    await user.click(removeButtons[0])
    expect(onRemove).toHaveBeenCalledWith('a-1')
  })
})
```

- [ ] **Step 2: Run, expect failure**

```bash
pnpm test:unit -- --run packages/app/src/components/chat/__tests__/AgentChipBar.test.tsx
```
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

Create `packages/app/src/components/chat/AgentChipBar.tsx`:

```tsx
import { Sparkles, X } from 'lucide-react'
import type { AttachedAgent } from '@/packages/ai/prompt-input-insert-hooks'

interface AgentChipBarProps {
  agents: AttachedAgent[]
  onRemove: (id: string) => void
}

export function AgentChipBar({ agents, onRemove }: AgentChipBarProps) {
  if (agents.length === 0) return null
  return (
    <div className="flex flex-wrap gap-1.5 px-2 py-1.5 border-b">
      {agents.map(a => (
        <span
          key={a.id}
          className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-md border bg-orange-50 border-orange-200 text-orange-700 text-xs font-medium dark:bg-orange-950 dark:border-orange-800 dark:text-orange-300"
        >
          <Sparkles className="h-3 w-3 shrink-0" />
          <span className="truncate max-w-[200px]">{a.displayName}</span>
          <button
            type="button"
            aria-label={`Remove ${a.displayName}`}
            onClick={() => onRemove(a.id)}
            className="ml-0.5 inline-flex items-center justify-center rounded-full hover:bg-orange-200 dark:hover:bg-orange-900"
            style={{ width: 14, height: 14 }}
          >
            <X className="h-3 w-3" />
          </button>
        </span>
      ))}
    </div>
  )
}
```

- [ ] **Step 4: Run, expect pass**

```bash
pnpm test:unit -- --run packages/app/src/components/chat/__tests__/AgentChipBar.test.tsx
```
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/app/src/components/chat/AgentChipBar.tsx packages/app/src/components/chat/__tests__/AgentChipBar.test.tsx
git commit -m "feat(chat): add AgentChipBar component"
```

---

## Task 6: Wire `#` and `@` triggers in `ChatInputArea`

This is the integration step. Three changes to `ChatInputArea.tsx`:
1. Add `attachedAgents`, `onAttachAgent`, `onRemoveAgent` to `ChatInputAreaProps`.
2. Render `<AgentChipBar />` above the editor.
3. Move `FileMentionPopoverWrapper` to consume `onHashTrigger`/`onHashClose` (and call `createInsertHashFile`); add a new `MentionPopoverWrapper` that consumes `onMentionTrigger`/`onMentionClose` and routes member→`createInsertMention` / agent→`createInsertAgentMention`.
4. Update placeholder text to use the new i18n key (already updated value in Task 1).

**Files:**
- Modify: `packages/app/src/components/chat/ChatInputArea.tsx`

- [ ] **Step 1: Read the current `ChatInputAreaProps` and `FileMentionPopoverWrapper`**

```bash
sed -n '40,75p;100,150p' packages/app/src/components/chat/ChatInputArea.tsx
```
Note the exact prop names and the wrapper's signature so the edit lands cleanly.

- [ ] **Step 2: Extend `ChatInputAreaProps`**

Find `interface ChatInputAreaProps {` (around line 101) and append three fields before the closing `}`:

```ts
  attachedAgents: AttachedAgent[];
  onAttachAgent: (agent: AttachedAgent) => void;
  onRemoveAgent: (id: string) => void;
```

Add the import at the top of the file (next to other `@/packages/ai/...` imports):

```ts
import type { AttachedAgent } from '@/packages/ai/prompt-input-insert-hooks'
import { AgentChipBar } from './AgentChipBar'
import { MentionPopover } from './MentionPopover'
```

Add the three props to the function destructure (around line 124-134):

```ts
  attachedAgents,
  onAttachAgent,
  onRemoveAgent,
```

- [ ] **Step 3: Replace `FileMentionPopoverWrapper` `@` wiring with `#`**

Locate the `FileMentionPopoverWrapper` (`function FileMentionPopoverWrapper(...)` around line 46). It calls `createInsertFileMention(context)` and consumes the mention-trigger plumbing. Replace its body so it uses `createInsertHashFile`:

Find:
```ts
  const insertFileMention = React.useMemo(
    () => createInsertFileMention(context),
    [context],
  );
```
Replace with:
```ts
  const insertFileMention = React.useMemo(
    () => createInsertHashFile(context),
    [context],
  );
```

Add the import at the top of the file:
```ts
import { createInsertHashFile, createInsertAgentMention } from '@/packages/ai/prompt-input-insert-hooks'
```
(remove `createInsertFileMention` from that import if it was there — verify with `grep "createInsertFileMention" packages/app/src/components/chat/ChatInputArea.tsx` after the edit.)

- [ ] **Step 4: Replace the `@` wiring on the `<PromptInput>` with `#` for files**

Find (around line 271-276):
```tsx
            onMentionTrigger={(query) => {
              setHashSearchQuery(query);
              setMentionPopoverOpen(true);
            }}
            onMentionClose={() => {
              setMentionPopoverOpen(false);
            }}
```
Rename these props to the hash variants. Two changes (the two callsite identifiers):
- `onMentionTrigger` → `onHashTrigger`
- `onMentionClose` → `onHashClose`

Also rename the local state for clarity:
- `mentionPopoverOpen` → `filePopoverOpen`
- `setMentionPopoverOpen` → `setFilePopoverOpen`
- `hashSearchQuery` keeps its name (or rename to `fileSearchQuery` if you prefer; whichever, do it consistently). Use `replace_all` for the rename.

- [ ] **Step 5: Add a separate `MentionPopoverWrapper` for `@`**

Below `FileMentionPopoverWrapper`, add:

```tsx
function MentionPopoverWrapper({
  open,
  onOpenChange,
  searchQuery,
  onAttachAgent,
}: {
  open: boolean;
  onOpenChange: (next: boolean) => void;
  searchQuery: string;
  onAttachAgent: (agent: AttachedAgent) => void;
}) {
  // (`AttachedAgent` is the canonical type, exported from prompt-input-insert-hooks; MentionPopover imports it.)
  const context = usePromptInputContext();
  const insertMember = React.useMemo(() => createInsertMention(context), [context]);
  const insertAgent = React.useMemo(
    () => createInsertAgentMention(context, onAttachAgent),
    [context, onAttachAgent],
  );
  const [innerQuery, setInnerQuery] = React.useState(searchQuery);
  React.useEffect(() => { setInnerQuery(searchQuery); }, [searchQuery]);
  return (
    <MentionPopover
      open={open}
      onOpenChange={onOpenChange}
      searchQuery={innerQuery}
      onSearchChange={setInnerQuery}
      onSelectMember={(person) => insertMember(person)}
      onSelectAgent={(agent) => insertAgent(agent)}
    />
  );
}
```

`createInsertMention` is already exported from `prompt-input-insert-hooks`; ensure it's imported at the top:
```ts
import { createInsertMention, createInsertHashFile, createInsertAgentMention } from '@/packages/ai/prompt-input-insert-hooks'
```

`usePromptInputContext` should already be imported (used by FileMentionPopoverWrapper). If not, add it.

- [ ] **Step 6: Wire `@` trigger to `MentionPopoverWrapper`**

In the `<PromptInput>` block, alongside `onHashTrigger`/`onHashClose`, add:

```tsx
            onMentionTrigger={(query) => {
              setMentionSearchQuery(query);
              setMentionPopoverOpen(true);
            }}
            onMentionClose={() => {
              setMentionPopoverOpen(false);
            }}
```

Add the matching local state near `filePopoverOpen` / `hashSearchQuery`:

```tsx
  const [mentionPopoverOpen, setMentionPopoverOpen] = React.useState(false);
  const [mentionSearchQuery, setMentionSearchQuery] = React.useState("");
```

- [ ] **Step 7: Render the `<AgentChipBar />` and `<MentionPopoverWrapper />`**

Find the `<FileMentionPopoverWrapper ...>` mount point (around line 396-398). Add the mention popover next to it:

```tsx
          <MentionPopoverWrapper
            open={mentionPopoverOpen}
            onOpenChange={setMentionPopoverOpen}
            searchQuery={mentionSearchQuery}
            onAttachAgent={onAttachAgent}
          />
```

Find where `attachedFiles.length > 0` renders the file chips above the input (line 321-323). Above that block (or below it — outside the editor, anywhere visually appropriate), render:

```tsx
          <AgentChipBar agents={attachedAgents} onRemove={onRemoveAgent} />
```

- [ ] **Step 8: Update placeholder reference to use the new i18n value**

Find `t('chat.inputPlaceholderMention', 'Type @ to reference files...')` on line ~390 and update the fallback string to match the new value:

```tsx
t('chat.inputPlaceholderMention', 'Mention with @, reference files with #...')
```

The fallback is used only if i18n lookup misses; the JSON change in Task 1 is the source of truth.

- [ ] **Step 9: Typecheck and run**

```bash
pnpm typecheck
```
Expected: no new errors. If `ChatInputAreaProps` consumers (only `ChatPanel.tsx`) now lack the three new fields, TS will flag — that's expected; Task 7 fixes it.

```bash
pnpm test:unit -- --run packages/app/src/components/chat
```
Expected: chat-area tests still pass for non-mention paths; `ChatPanel-submission` may fail — that's expected; Task 7 fixes it.

- [ ] **Step 10: Commit (intermediate, type errors permitted in ChatPanel only)**

We commit despite ChatPanel's type errors because the next task is small and self-contained. If you prefer red bars never landing on the branch, defer this commit and combine with Task 7.

```bash
git add packages/app/src/components/chat/ChatInputArea.tsx
git commit -m "feat(chat): swap # for files and @ for session participants in ChatInputArea"
```

---

## Task 7: Plumb `attachedAgents` through `ChatPanel` and populate `mentionActorIds` on send

**Files:**
- Modify: `packages/app/src/components/chat/ChatPanel.tsx`
- Test: `packages/app/src/components/chat/__tests__/ChatPanel-submission.test.tsx` (extend)

- [ ] **Step 1: Read the current `send` to confirm the line range**

```bash
grep -n "appendMessage\|mqttPublish\|mentionActorIds\|attachedFiles\|outgoing" packages/app/src/components/chat/ChatPanel.tsx | head -25
```
Confirm the send block starts around line 770 and the `[File: ...]` replacement is around line 685-693.

- [ ] **Step 2: Add `attachedAgents` state next to `attachedFiles`**

In `ChatPanel.tsx`, find `const [attachedFiles, setAttachedFiles] = React.useState<string[]>([])` (or wherever `attachedFiles` is declared — could be a Zustand selector if lifted further; if so, add an equivalent local `useState` for `attachedAgents`). Add:

```tsx
  const [attachedAgents, setAttachedAgents] = React.useState<AttachedAgent[]>([]);
```

Add the import at the top:
```ts
import type { AttachedAgent } from '@/packages/ai/prompt-input-insert-hooks'
```

Pass new props to `<ChatInputArea>` (find the JSX usage of `<ChatInputArea ...>`):

```tsx
            attachedAgents={attachedAgents}
            onAttachAgent={(a) => setAttachedAgents(prev =>
              prev.some(x => x.id === a.id) ? prev : [...prev, a]
            )}
            onRemoveAgent={(id) => setAttachedAgents(prev => prev.filter(x => x.id !== id))}
```

- [ ] **Step 3: Read `mentions` from PromptInputContext on submit**

`ChatInputArea`'s `onSubmit` already passes a `PromptInputMessage`. We need the mentions list too. Look up the PromptInputMessage type:

```bash
grep -n "PromptInputMessage" packages/app/src/packages/ai/prompt-input-types.ts packages/app/src/packages/ai/prompt-input.tsx | head -10
```

If `PromptInputMessage` already includes `mentions: MentionedPerson[]`, use that. Otherwise extend it: open `prompt-input-types.ts` and add `mentions?: MentionedPerson[]` to the message type, then make sure `prompt-input.tsx`'s submit handler includes the current `mentions` state.

If you find the message type already wires `mentions`, no edit needed; just consume `message.mentions` in `ChatPanel.send`.

- [ ] **Step 4: Update `ChatPanel.send` to populate `mentionActorIds` + Supabase metadata**

Locate the existing block (around line 685-810):

```ts
const outgoing = inputValue.replace(/@\{([^}]+)\}/g, '[File: $1]');
// …
const sessionMsg = createMessage(SessionMessageEnvelopeSchema, {
  message,
  mentionActorIds: [],
});
// …
const { error: insErr } = await supabase.from('messages').insert({
  id: messageId,
  team_id: sessionRow.team_id,
  session_id: sid,
  sender_actor_id: senderActorId,
  kind: 'text',
  content: outgoing,
});
```

Replace with:

```ts
const outgoing = inputValue.replace(/@\{([^}]+)\}/g, '[File: $1]');

const memberIds = (message.mentions ?? []).map(m => m.id);
const agentIds = attachedAgents.map(a => a.id);
const mentionActorIds = Array.from(new Set([...memberIds, ...agentIds]));

const sessionMsg = createMessage(SessionMessageEnvelopeSchema, {
  message: messageProto,
  mentionActorIds,
});
// … existing publish call …
const { error: insErr } = await supabase.from('messages').insert({
  id: messageId,
  team_id: sessionRow.team_id,
  session_id: sid,
  sender_actor_id: senderActorId,
  kind: 'text',
  content: outgoing,
  metadata: { mention_actor_ids: mentionActorIds },
});
```

(`message` here is the `PromptInputMessage` from `ChatInputArea.onSubmit`. Rename your local proto variable if it was also called `message` to avoid shadowing — e.g. `messageProto` as shown above; pick whatever the existing code calls it.)

After the insert succeeds, clear local state:
```ts
setAttachedAgents([]);
```

- [ ] **Step 5: Extend `ChatPanel-submission.test.tsx`**

Add a new test to the file's `describe` block:

```tsx
  it('populates mentionActorIds (deduped) on send and persists metadata', async () => {
    const sendCapture: any[] = []
    mockSendMessage.mockImplementation((msg: any) => { sendCapture.push(msg); return Promise.resolve() })
    // … set up render, simulate submitting a message with one member mention
    // and one agent in attachedAgents (use the test's existing render harness)
    // Assert:
    //   captured envelope.mentionActorIds === ['m-1', 'a-1']
    //   supabase.from('messages').insert called with metadata.mention_actor_ids === ['m-1', 'a-1']
  })
```

The exact harness mechanics depend on how the existing tests render `ChatPanel`. Mirror the patterns of the existing send tests in this file (they already mock `supabase`, `mqttPublish`, and the session store).

- [ ] **Step 6: Run typecheck and tests**

```bash
pnpm typecheck
pnpm test:unit -- --run packages/app/src/components/chat
```
Expected: typecheck zero errors; chat tests all pass.

- [ ] **Step 7: Commit**

```bash
git add packages/app/src/components/chat/ChatPanel.tsx packages/app/src/components/chat/__tests__/ChatPanel-submission.test.tsx
git commit -m "feat(chat): populate mentionActorIds + metadata.mention_actor_ids on send"
```

---

## Task 8: Feature flag `VITE_MENTION_REDESIGN`

A safety net for fast rollback. Default ON. Only the `@` and `#` swap is gated; member-mention plain-text insertion is unaffected (mentions popover wasn't user-visible before this change).

**Files:**
- Modify: `packages/app/src/components/chat/ChatInputArea.tsx`

- [ ] **Step 1: Read the trigger wiring you added in Task 6**

Confirm the two prop sets on `<PromptInput>` are `onHashTrigger`/`onHashClose` (file popover) and `onMentionTrigger`/`onMentionClose` (mention popover).

- [ ] **Step 2: Gate the wiring**

At the top of `ChatInputArea.tsx`, after imports:

```ts
const REDESIGN_ON = import.meta.env.VITE_MENTION_REDESIGN !== 'false';
```

In the `<PromptInput>` block, change the trigger props to a conditional:

```tsx
            onHashTrigger={REDESIGN_ON ? (query) => {
              setHashSearchQuery(query);
              setFilePopoverOpen(true);
            } : undefined}
            onHashClose={REDESIGN_ON ? () => setFilePopoverOpen(false) : undefined}
            onMentionTrigger={REDESIGN_ON
              ? (query) => { setMentionSearchQuery(query); setMentionPopoverOpen(true); }
              : (query) => { setHashSearchQuery(query); setFilePopoverOpen(true); }
            }
            onMentionClose={REDESIGN_ON
              ? () => setMentionPopoverOpen(false)
              : () => setFilePopoverOpen(false)
            }
```

When the flag is off, `@` falls back to the file popover (old behavior); `#` does nothing.

Also gate the `<MentionPopoverWrapper />` and `<AgentChipBar />` mounts:
```tsx
          {REDESIGN_ON && (
            <MentionPopoverWrapper
              open={mentionPopoverOpen}
              onOpenChange={setMentionPopoverOpen}
              searchQuery={mentionSearchQuery}
              onAttachAgent={onAttachAgent}
            />
          )}
          {REDESIGN_ON && <AgentChipBar agents={attachedAgents} onRemove={onRemoveAgent} />}
```

- [ ] **Step 3: Typecheck**

```bash
pnpm typecheck
```
Expected: zero errors.

- [ ] **Step 4: Manual smoke (optional, only if Tauri dev is stable)**

If `pnpm tauri:dev` is workable in the local env: launch the app, type `#` and verify file popover opens; type `@` and verify mention popover opens; pick an agent and verify chip appears above input. (Skip if dev environment is being shared and unstable — the unit tests cover the contract.)

- [ ] **Step 5: Commit**

```bash
git add packages/app/src/components/chat/ChatInputArea.tsx
git commit -m "feat(chat): VITE_MENTION_REDESIGN flag for the @/# swap"
```

---

## Task 9: Final verification

- [ ] **Step 1: Run full unit suite**

```bash
pnpm test:unit -- --run
```
Expected: all green.

- [ ] **Step 2: Run typecheck**

```bash
pnpm typecheck
```
Expected: zero errors.

- [ ] **Step 3: Run lint**

```bash
pnpm lint
```
Expected: zero new warnings vs baseline.

- [ ] **Step 4: Confirm spec coverage**

Open `docs/superpowers/specs/2026-05-09-mention-trigger-redesign-design.md` and walk through each "Goals" bullet. Confirm:
- `#` triggers file popover ✓ (Task 6)
- `@` triggers session-participant popover ✓ (Task 4 + Task 6)
- Member → inline `@Name` ✓ (Task 6 via existing `createInsertMention`)
- Agent → above-composer chip ✓ (Task 5 + Task 6)
- `mentionActorIds` populated on send + persisted ✓ (Task 7)
- Scope: only ChatPanel/ChatInputArea — `ActorChatInput` untouched ✓ (verify with `git diff main..HEAD -- packages/app/src/components/chat/ActorChatInput.tsx` — should be empty)

- [ ] **Step 5: Final commit (if there are any leftover unstaged changes)**

```bash
git status --short
# If clean, no commit needed.
# If dirty (e.g. lockfile updated incidentally): inspect, stage, commit with descriptive message.
```

- [ ] **Step 6: Hand back to user for review**

Surface to user: branch state, list of new commits, links to spec + plan, request review before pushing or merging.

---

## Risks / things to watch

- **`PromptInputMessage.mentions` may not be plumbed today.** Task 7 Step 3 verifies. If absent, add it before Step 4 — the type extension is a small change but easy to forget.
- **Supabase RLS on `session_participants`.** The current user must be allowed to read participants for the session. Phase 1 `session_select_only_participants` migration restricts session reads to participants — the same restriction may apply to `session_participants` itself. If reads return empty unexpectedly in dev, check Supabase RLS policies on `session_participants` and `actors`.
- **Stale 30s cache during fast switching.** The popover cache invalidates on session id change; rapid in-session participant adds (e.g. agent joining) won't appear until cache expires. Acceptable for Phase 1.
- **Old `createInsertFileMention` left in place.** It's now dead. Cleanup is deliberately deferred to keep this PR focused; remove in a follow-up.

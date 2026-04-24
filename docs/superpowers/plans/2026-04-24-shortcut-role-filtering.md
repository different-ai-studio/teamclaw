# Shortcut Role Filtering Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add member-based shortcut role filtering so team shortcuts in `teamclaw-team/_meta/shortcuts.json` are shown only to members whose `shortcutsRole` intersects the shortcut's `role` array.

**Architecture:** Keep file loading and saving unfiltered, store the current member's shortcut roles in the frontend shortcuts store, and apply visibility filtering inside `getTeamTree()` and `getTree()`. Extend the shared Rust `TeamMember` schema with `shortcutsRole` so new and existing manifests deserialize consistently.

**Tech Stack:** React 19, Zustand, Vitest, TypeScript, Tauri Rust commands, serde.

---

## File Structure

- `packages/app/src/stores/shortcuts.ts`: Owns `ShortcutNode`, team shortcut state, current shortcut roles, tree building, and team shortcut visibility filtering.
- `packages/app/src/stores/__tests__/shortcuts.test.ts`: Unit tests for unrestricted shortcuts, role intersections, hidden shortcuts, and folder preservation.
- `packages/app/src/lib/git/types.ts`: Frontend `TeamMember` type gains `shortcutsRole?: string[]`.
- `packages/app/src/stores/team-members.ts`: After members or current node ID load, pushes the current member's `shortcutsRole` into the shortcuts store.
- `packages/app/src/stores/__tests__/team-members-shortcuts-role.test.ts`: Unit tests for syncing and clearing current member shortcut roles.
- `packages/app/src/lib/__tests__/team-shortcuts.test.ts`: Verifies role arrays survive shortcut file load/save.
- `src-tauri/crates/teamclaw-sync/src/oss_types.rs`: Canonical Rust `TeamMember` gains `shortcuts_role: Vec<String>` with serde defaulting and unit coverage.
- Rust files constructing `TeamMember`: initialize `shortcuts_role: Vec::new()` in `src-tauri/src/commands/team.rs`, `src-tauri/src/commands/team_unified.rs`, `src-tauri/src/commands/oss_commands.rs`, `src-tauri/src/commands/team_p2p.rs`, and `src-tauri/crates/teamclaw-p2p/src/lib.rs`.

## Task 1: Shortcut Store Role Filtering

**Files:**
- Modify: `packages/app/src/stores/shortcuts.ts`
- Test: `packages/app/src/stores/__tests__/shortcuts.test.ts`

- [ ] **Step 1: Write failing store tests**

Append these tests to `packages/app/src/stores/__tests__/shortcuts.test.ts` inside the existing `describe('shortcuts store', () => { ... })` block:

```ts
  it('keeps unrestricted team shortcuts visible when current shortcut roles are empty', () => {
    useShortcutsStore.setState({
      nodes: [],
      teamNodes: [
        { id: 'missing-role', label: 'Docs', order: 0, parentId: null, type: 'link', target: 'https://docs.example.com' },
        { id: 'empty-role', label: 'Wiki', order: 1, parentId: null, type: 'link', target: 'https://wiki.example.com', role: [] },
      ],
      teamLoaded: true,
    })
    useShortcutsStore.getState().setCurrentShortcutRoles([])

    const tree = useShortcutsStore.getState().getTeamTree()

    expect(tree.map((node) => node.id)).toEqual(['missing-role', 'empty-role'])
  })

  it('filters restricted team shortcuts by current member shortcut roles', () => {
    useShortcutsStore.setState({
      nodes: [],
      teamNodes: [
        { id: 'sales', label: 'Sales CRM', order: 0, parentId: null, type: 'link', target: 'https://sales.example.com', role: ['sales'] },
        { id: 'support', label: 'Support Queue', order: 1, parentId: null, type: 'link', target: 'https://support.example.com', role: ['support'] },
        { id: 'public', label: 'Handbook', order: 2, parentId: null, type: 'link', target: 'https://handbook.example.com' },
      ],
      teamLoaded: true,
    })
    useShortcutsStore.getState().setCurrentShortcutRoles(['sales'])

    const tree = useShortcutsStore.getState().getTeamTree()

    expect(tree.map((node) => node.id)).toEqual(['sales', 'public'])
  })

  it('hides restricted team shortcuts when no current member shortcut role matches', () => {
    useShortcutsStore.setState({
      nodes: [],
      teamNodes: [
        { id: 'sales', label: 'Sales CRM', order: 0, parentId: null, type: 'link', target: 'https://sales.example.com', role: ['sales'] },
        { id: 'support', label: 'Support Queue', order: 1, parentId: null, type: 'link', target: 'https://support.example.com', role: ['support'] },
      ],
      teamLoaded: true,
    })
    useShortcutsStore.getState().setCurrentShortcutRoles(['ops'])

    const tree = useShortcutsStore.getState().getTeamTree()

    expect(tree).toEqual([])
  })

  it('keeps a restricted folder when a visible child remains', () => {
    useShortcutsStore.setState({
      nodes: [],
      teamNodes: [
        { id: 'folder', label: 'Team Tools', order: 0, parentId: null, type: 'folder', target: '', role: ['admin'] },
        { id: 'sales-child', label: 'Sales CRM', order: 0, parentId: 'folder', type: 'link', target: 'https://sales.example.com', role: ['sales'] },
        { id: 'support-child', label: 'Support Queue', order: 1, parentId: 'folder', type: 'link', target: 'https://support.example.com', role: ['support'] },
      ],
      teamLoaded: true,
    })
    useShortcutsStore.getState().setCurrentShortcutRoles(['sales'])

    const tree = useShortcutsStore.getState().getTeamTree()

    expect(tree).toHaveLength(1)
    expect(tree[0].id).toBe('folder')
    expect(tree[0].children?.map((node) => node.id)).toEqual(['sales-child'])
  })
```

- [ ] **Step 2: Run tests and confirm the expected failure**

Run:

```bash
pnpm --filter @teamclaw/app exec vitest run src/stores/__tests__/shortcuts.test.ts
```

Expected: FAIL because `setCurrentShortcutRoles` and `role` are not part of the shortcuts store type yet.

- [ ] **Step 3: Implement role filtering in the shortcuts store**

In `packages/app/src/stores/shortcuts.ts`, update `ShortcutNode`, `ShortcutsState`, helper functions, initial state, and selectors as follows:

```ts
export interface ShortcutNode {
  id: string
  label: string
  icon?: string
  order: number
  parentId: string | null
  type: 'native' | 'link' | 'folder'
  target: string
  role?: string[]
  children?: ShortcutNode[]
}

interface ShortcutsState {
  nodes: ShortcutNode[]
  teamNodes: ShortcutNode[]
  teamLoaded: boolean
  currentShortcutRoles: string[]

  addNode: (node: Omit<ShortcutNode, 'id'>) => string
  updateNode: (id: string, updates: Partial<ShortcutNode>) => void
  deleteNode: (id: string) => void
  moveNode: (id: string, parentId: string | null, order: number) => void
  batchMove: (moves: { id: string; parentId: string | null; order: number }[]) => void
  getTree: () => ShortcutNode[]
  getPersonalTree: () => ShortcutNode[]
  getTeamTree: () => ShortcutNode[]
  getChildren: (parentId: string | null) => ShortcutNode[]
  setTeamNodes: (nodes: ShortcutNode[]) => void
  setCurrentShortcutRoles: (roles: string[] | null | undefined) => void
}

function normalizeRoles(roles: string[] | null | undefined): string[] {
  if (!Array.isArray(roles)) return []
  return roles.filter((role): role is string => typeof role === 'string' && role.trim().length > 0)
}

function canSeeTeamShortcut(node: ShortcutNode, currentRoles: string[]): boolean {
  const shortcutRoles = normalizeRoles(node.role)
  if (shortcutRoles.length === 0) return true
  if (currentRoles.length === 0) return false
  const currentRoleSet = new Set(currentRoles)
  return shortcutRoles.some((role) => currentRoleSet.has(role))
}

function filterTeamTreeForRoles(tree: ShortcutNode[], currentRoles: string[]): ShortcutNode[] {
  return tree.flatMap((node) => {
    const filteredChildren = filterTeamTreeForRoles(node.children ?? [], currentRoles)
    if (!canSeeTeamShortcut(node, currentRoles) && filteredChildren.length === 0) {
      return []
    }
    return [{ ...node, children: filteredChildren }]
  })
}
```

Set the initial value:

```ts
  currentShortcutRoles: [],
```

Update `getTree()` and `getTeamTree()`:

```ts
  getTree: () => {
    const { nodes, teamNodes, currentShortcutRoles } = get()
    const personalTree = buildTree(nodes, null)
    const teamTree = filterTeamTreeForRoles(buildTree(teamNodes, null), currentShortcutRoles)
    return [...personalTree, ...teamTree]
  },

  getTeamTree: () => {
    const { teamNodes, currentShortcutRoles } = get()
    return filterTeamTreeForRoles(buildTree(teamNodes, null), currentShortcutRoles)
  },
```

Add the setter:

```ts
  setCurrentShortcutRoles: (roles) => {
    set({ currentShortcutRoles: normalizeRoles(roles) })
  },
```

- [ ] **Step 4: Run store tests and confirm they pass**

Run:

```bash
pnpm --filter @teamclaw/app exec vitest run src/stores/__tests__/shortcuts.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit Task 1**

```bash
git add packages/app/src/stores/shortcuts.ts packages/app/src/stores/__tests__/shortcuts.test.ts
git commit -m "feat(shortcuts): filter team shortcuts by role"
```

## Task 2: Current Member Shortcut Role Sync

**Files:**
- Modify: `packages/app/src/lib/git/types.ts`
- Modify: `packages/app/src/stores/team-members.ts`
- Create: `packages/app/src/stores/__tests__/team-members-shortcuts-role.test.ts`

- [ ] **Step 1: Write failing team member sync tests**

Create `packages/app/src/stores/__tests__/team-members-shortcuts-role.test.ts`:

```ts
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mockInvoke = vi.hoisted(() => vi.fn())

vi.mock('@tauri-apps/api/core', () => ({
  invoke: (...args: unknown[]) => mockInvoke(...args),
}))

vi.mock('@/lib/storage', () => ({
  loadFromStorage: vi.fn(() => ({ nodes: [], version: 1 })),
  saveToStorage: vi.fn(),
}))

describe('team members shortcut role sync', () => {
  beforeEach(async () => {
    vi.clearAllMocks()
    const { useShortcutsStore } = await import('@/stores/shortcuts')
    const { useTeamMembersStore } = await import('@/stores/team-members')
    useShortcutsStore.setState({
      nodes: [],
      teamNodes: [],
      teamLoaded: false,
      currentShortcutRoles: [],
    })
    useTeamMembersStore.setState({
      members: [],
      myRole: null,
      loading: false,
      error: null,
      applications: [],
      _unlistenApplications: null,
      currentNodeId: null,
    })
  })

  it('sets current shortcut roles when members and current node id are loaded', async () => {
    mockInvoke.mockImplementation(async (command: string) => {
      if (command === 'get_device_info') return { nodeId: 'node-1' }
      if (command === 'unified_team_get_members') {
        return [
          {
            nodeId: 'node-1',
            name: 'Alice',
            role: 'editor',
            shortcutsRole: ['sales', 'support'],
            label: '',
            platform: 'darwin',
            arch: 'arm64',
            hostname: 'alice-mac',
            addedAt: '2026-04-24T00:00:00Z',
          },
        ]
      }
      return null
    })

    const { useShortcutsStore } = await import('@/stores/shortcuts')
    const { useTeamMembersStore } = await import('@/stores/team-members')

    await useTeamMembersStore.getState().loadCurrentNodeId()
    await useTeamMembersStore.getState().loadMembers()

    expect(useShortcutsStore.getState().currentShortcutRoles).toEqual(['sales', 'support'])
  })

  it('clears current shortcut roles when the team members store resets', async () => {
    const { useShortcutsStore } = await import('@/stores/shortcuts')
    const { useTeamMembersStore } = await import('@/stores/team-members')

    useShortcutsStore.getState().setCurrentShortcutRoles(['sales'])
    useTeamMembersStore.getState().reset()

    expect(useShortcutsStore.getState().currentShortcutRoles).toEqual([])
  })
})
```

- [ ] **Step 2: Run the new test and confirm the expected failure**

Run:

```bash
pnpm --filter @teamclaw/app exec vitest run src/stores/__tests__/team-members-shortcuts-role.test.ts
```

Expected: FAIL because `TeamMember` does not expose `shortcutsRole` and `team-members.ts` does not sync shortcut roles into the shortcuts store.

- [ ] **Step 3: Add the frontend member type field**

In `packages/app/src/lib/git/types.ts`, extend `TeamMember`:

```ts
  /** Shortcut visibility roles used to filter team shortcuts */
  shortcutsRole?: string[]
```

Place it after the existing `role?: 'owner' | 'manager' | 'editor' | 'viewer'` field.

- [ ] **Step 4: Sync current member shortcut roles**

In `packages/app/src/stores/team-members.ts`, add the import:

```ts
import { useShortcutsStore } from './shortcuts'
```

Add these helpers above `export const useTeamMembersStore`:

```ts
function normalizeShortcutRoles(roles: string[] | null | undefined): string[] {
  if (!Array.isArray(roles)) return []
  return roles.filter((role): role is string => typeof role === 'string' && role.trim().length > 0)
}

function syncCurrentShortcutRoles(members: TeamMember[], currentNodeId: string | null): void {
  const currentMember = currentNodeId
    ? members.find((member) => member.nodeId === currentNodeId)
    : undefined
  useShortcutsStore.getState().setCurrentShortcutRoles(
    normalizeShortcutRoles(currentMember?.shortcutsRole),
  )
}
```

Update `loadCurrentNodeId`:

```ts
  loadCurrentNodeId: async () => {
    if (get().currentNodeId) return
    try {
      const info = await invoke<{ nodeId: string }>('get_device_info')
      set({ currentNodeId: info.nodeId })
      syncCurrentShortcutRoles(get().members, info.nodeId)
    } catch {
      // P2P node not running yet — will retry next call
    }
  },
```

Update `loadMembers`:

```ts
  loadMembers: async () => {
    set({ loading: true, error: null })
    try {
      const members = await invoke<TeamMember[]>('unified_team_get_members')
      set({ members, loading: false })
      syncCurrentShortcutRoles(members, get().currentNodeId)
    } catch (e) {
      set({ error: String(e), loading: false })
    }
  },
```

Update `reset` so it clears shortcut roles:

```ts
    useShortcutsStore.getState().setCurrentShortcutRoles([])
```

Place that line after `_unlistenApplications()` is called and before `set({ ... })`.

- [ ] **Step 5: Run the new team member sync test**

Run:

```bash
pnpm --filter @teamclaw/app exec vitest run src/stores/__tests__/team-members-shortcuts-role.test.ts
```

Expected: PASS.

- [ ] **Step 6: Run the existing shortcuts store tests**

Run:

```bash
pnpm --filter @teamclaw/app exec vitest run src/stores/__tests__/shortcuts.test.ts
```

Expected: PASS.

- [ ] **Step 7: Commit Task 2**

```bash
git add packages/app/src/lib/git/types.ts packages/app/src/stores/team-members.ts packages/app/src/stores/__tests__/team-members-shortcuts-role.test.ts
git commit -m "feat(team): sync shortcut roles from current member"
```

## Task 3: Team Shortcuts File Role Preservation

**Files:**
- Modify: `packages/app/src/lib/__tests__/team-shortcuts.test.ts`

- [ ] **Step 1: Strengthen load and save tests**

In `packages/app/src/lib/__tests__/team-shortcuts.test.ts`, update the `parses valid shortcuts file` fixture to include `role: ['sales']`, then add this assertion:

```ts
    expect(result![0].role).toEqual(['sales'])
```

Update the `creates _meta directory before saving` test to pass a shortcut with a role:

```ts
    const ok = await saveTeamShortcutsFile('/workspace', [
      { id: 'team-1', label: 'Team', order: 0, parentId: null, type: 'link', target: 'https://team.example.com', role: ['sales'] },
    ])
```

Update the expected write payload:

```ts
      JSON.stringify({
        version: 1,
        shortcuts: [
          { id: 'team-1', label: 'Team', order: 0, parentId: null, type: 'link', target: 'https://team.example.com', role: ['sales'] },
        ],
      }, null, 2),
```

- [ ] **Step 2: Run team shortcut file tests**

Run:

```bash
pnpm --filter @teamclaw/app exec vitest run src/lib/__tests__/team-shortcuts.test.ts
```

Expected: PASS. If this fails, inspect only `packages/app/src/lib/team-shortcuts.ts`; no filtering logic should be added there.

- [ ] **Step 3: Commit Task 3**

```bash
git add packages/app/src/lib/__tests__/team-shortcuts.test.ts
git commit -m "test(shortcuts): cover team shortcut roles in file IO"
```

## Task 4: Rust TeamMember Schema

**Files:**
- Modify: `src-tauri/crates/teamclaw-sync/src/oss_types.rs`
- Modify: `src-tauri/src/commands/team.rs`
- Modify: `src-tauri/src/commands/team_unified.rs`
- Modify: `src-tauri/src/commands/oss_commands.rs`
- Modify: `src-tauri/src/commands/team_p2p.rs`
- Modify: `src-tauri/crates/teamclaw-p2p/src/lib.rs`

- [ ] **Step 1: Write failing Rust schema test**

Add this test module to the bottom of `src-tauri/crates/teamclaw-sync/src/oss_types.rs`:

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn team_member_deserializes_missing_shortcuts_role_as_empty() {
        let member: TeamMember = serde_json::from_value(json!({
            "nodeId": "node-1",
            "name": "Alice",
            "role": "editor",
            "label": "",
            "platform": "darwin",
            "arch": "arm64",
            "hostname": "alice-mac",
            "addedAt": "2026-04-24T00:00:00Z"
        }))
        .expect("member without shortcutsRole should deserialize");

        assert!(member.shortcuts_role.is_empty());

        let value = serde_json::to_value(member).expect("member should serialize");
        assert_eq!(value["shortcutsRole"], json!([]));
    }

    #[test]
    fn team_member_round_trips_shortcuts_role() {
        let member: TeamMember = serde_json::from_value(json!({
            "nodeId": "node-1",
            "name": "Alice",
            "role": "editor",
            "shortcutsRole": ["sales", "support"],
            "label": "",
            "platform": "darwin",
            "arch": "arm64",
            "hostname": "alice-mac",
            "addedAt": "2026-04-24T00:00:00Z"
        }))
        .expect("member with shortcutsRole should deserialize");

        assert_eq!(member.shortcuts_role, vec!["sales".to_string(), "support".to_string()]);
    }
}
```

- [ ] **Step 2: Run the Rust test and confirm the expected failure**

Run:

```bash
cargo test --manifest-path src-tauri/Cargo.toml team_member_deserializes_missing_shortcuts_role_as_empty
```

Expected: FAIL to compile because `TeamMember` does not yet have `shortcuts_role`.

- [ ] **Step 3: Add the shared Rust schema field**

In `src-tauri/crates/teamclaw-sync/src/oss_types.rs`, add this field after `pub role: MemberRole`:

```rust
    #[serde(default)]
    pub shortcuts_role: Vec<String>,
```

- [ ] **Step 4: Initialize `shortcuts_role` in Rust `TeamMember` constructors**

For every `TeamMember { ... }` initializer reported by the compiler in these files, add:

```rust
                shortcuts_role: Vec::new(),
```

Use this placement immediately after the `role: ...` field. The affected files are:

```text
src-tauri/src/commands/team.rs
src-tauri/src/commands/team_unified.rs
src-tauri/src/commands/oss_commands.rs
src-tauri/src/commands/team_p2p.rs
src-tauri/crates/teamclaw-p2p/src/lib.rs
```

- [ ] **Step 5: Run the Rust schema tests**

Run:

```bash
cargo test --manifest-path src-tauri/Cargo.toml team_member_deserializes_missing_shortcuts_role_as_empty
cargo test --manifest-path src-tauri/Cargo.toml team_member_round_trips_shortcuts_role
```

Expected: PASS.

- [ ] **Step 6: Run Rust compile check**

Run:

```bash
pnpm rust:check
```

Expected: PASS.

- [ ] **Step 7: Commit Task 4**

```bash
git add src-tauri/crates/teamclaw-sync/src/oss_types.rs src-tauri/src/commands/team.rs src-tauri/src/commands/team_unified.rs src-tauri/src/commands/oss_commands.rs src-tauri/src/commands/team_p2p.rs src-tauri/crates/teamclaw-p2p/src/lib.rs
git commit -m "feat(team): add shortcut roles to member schema"
```

## Task 5: Final Verification

**Files:**
- No planned code changes.

- [ ] **Step 1: Run focused frontend tests**

Run:

```bash
pnpm --filter @teamclaw/app exec vitest run src/stores/__tests__/shortcuts.test.ts src/stores/__tests__/team-members-shortcuts-role.test.ts src/lib/__tests__/team-shortcuts.test.ts
```

Expected: PASS.

- [ ] **Step 2: Run frontend typecheck**

Run:

```bash
pnpm typecheck
```

Expected: PASS.

- [ ] **Step 3: Run Rust check**

Run:

```bash
pnpm rust:check
```

Expected: PASS.

- [ ] **Step 4: Inspect final diff**

Run:

```bash
git diff --stat HEAD
```

Expected: no unstaged implementation diff after task commits. If executing without per-task commits, expected changed files are exactly the files listed in this plan.

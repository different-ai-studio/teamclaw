# OpenCode Settings Model Catalog Alignment Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Settings → LLM Model list models from the same loopback `model-catalog` as the session picker (OpenCode `/config/providers`), while keeping `/providers` for connection management only.

**Architecture:** Add a pure helper that groups catalog `provider/model` refs by provider. `OpenCodeLLMSection` reads `useLocalDaemonCatalogStore` (via `ensureLocalDaemonCatalog(..., 'opencode')`) for model lists and expandability; `useProviderStore` stays authoritative for Connect / Disconnect / OAuth / custom CRUD. Catalog-only providers (e.g. free `opencode`) are merged into the visible provider list so they can expand without being `configured`.

**Tech Stack:** React 19, TypeScript, Zustand, Vitest, Testing Library; daemon loopback `GET /v1/workspaces/:id/model-catalog` (unchanged).

## Global Constraints

- Spec: `docs/superpowers/specs/2026-08-11-opencode-settings-model-catalog-design.md`
- Direction A: Settings shows the full session-equivalent model list; connection management retained.
- Model authority for Settings OpenCode section: loopback `model-catalog` / `local-daemon-catalog-store` — **not** MQTT retain, **not** `configuredProviders`.
- Connection authority: `GET /providers` / `useProviderStore.providers[].configured` unchanged.
- No daemon `/providers` contract changes.
- Team Shared LLM pane out of scope; session picker logic out of scope.
- Work on branch `feat/opencode-settings-model-catalog`; never push to `main`; commit per task; do not open a PR unless asked.
- Prefer TDD: failing test → implement → pass → commit.

## File structure

| File | Responsibility |
|---|---|
| `packages/app/src/lib/group-catalog-models-by-provider.ts` | Pure: group `{ id, displayName }[]` → per-provider model lists |
| `packages/app/src/lib/__tests__/group-catalog-models-by-provider.test.ts` | Unit tests for the helper |
| `packages/app/src/components/settings/LLMSection.tsx` | Wire OpenCode settings UI to catalog + expand rules + force refetch |
| `packages/app/src/components/settings/__tests__/LLMSection.test.tsx` | Component tests for catalog-backed listing / expand / refetch |

---

### Task 1: `groupCatalogModelsByProvider` helper (TDD)

**Files:**
- Create: `packages/app/src/lib/group-catalog-models-by-provider.ts`
- Create: `packages/app/src/lib/__tests__/group-catalog-models-by-provider.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export type CatalogModelOption = { id: string; name: string }
  export type CatalogProviderGroup = {
    providerId: string
    models: CatalogModelOption[]
  }

  /** Group `provider/model` catalog entries. Preserves input order; dedupes by full id. */
  export function groupCatalogModelsByProvider(
    models: ReadonlyArray<{ id: string; displayName?: string | null }>,
  ): CatalogProviderGroup[]

  /** Models for one provider id (case-sensitive match on the prefix before `/`). */
  export function catalogModelsForProvider(
    models: ReadonlyArray<{ id: string; displayName?: string | null }>,
    providerId: string,
  ): CatalogModelOption[]
  ```
- Consumes: nothing from other tasks.

- [ ] **Step 1: Write the failing tests**

```ts
import { describe, expect, it } from 'vitest'
import {
  catalogModelsForProvider,
  groupCatalogModelsByProvider,
} from '../group-catalog-models-by-provider'

describe('groupCatalogModelsByProvider', () => {
  it('groups by provider prefix and keeps full refs + display names', () => {
    const groups = groupCatalogModelsByProvider([
      { id: 'opencode/qwen3.6-plus-free', displayName: 'OpenCode Zen/Qwen3.6 Plus Free' },
      { id: 'anthropic/claude-sonnet-4', displayName: 'Claude Sonnet 4' },
      { id: 'opencode/gpt-5-nano', displayName: 'OpenCode Zen/GPT-5 Nano' },
    ])
    expect(groups).toEqual([
      {
        providerId: 'opencode',
        models: [
          { id: 'opencode/qwen3.6-plus-free', name: 'OpenCode Zen/Qwen3.6 Plus Free' },
          { id: 'opencode/gpt-5-nano', name: 'OpenCode Zen/GPT-5 Nano' },
        ],
      },
      {
        providerId: 'anthropic',
        models: [{ id: 'anthropic/claude-sonnet-4', name: 'Claude Sonnet 4' }],
      },
    ])
  })

  it('dedupes by full id and falls back name to id', () => {
    const groups = groupCatalogModelsByProvider([
      { id: 'opencode/a', displayName: 'A' },
      { id: 'opencode/a', displayName: 'A duplicate' },
      { id: 'opencode/b', displayName: '  ' },
      { id: '', displayName: 'skip' },
      { id: 'nopath', displayName: 'No slash' },
    ])
    expect(groups).toEqual([
      {
        providerId: 'opencode',
        models: [
          { id: 'opencode/a', name: 'A' },
          { id: 'opencode/b', name: 'opencode/b' },
        ],
      },
      {
        providerId: 'nopath',
        models: [{ id: 'nopath', name: 'No slash' }],
      },
    ])
  })

  it('catalogModelsForProvider returns only that provider', () => {
    const models = catalogModelsForProvider(
      [
        { id: 'opencode/a', displayName: 'A' },
        { id: 'openai/b', displayName: 'B' },
      ],
      'opencode',
    )
    expect(models).toEqual([{ id: 'opencode/a', name: 'A' }])
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm exec vitest run packages/app/src/lib/__tests__/group-catalog-models-by-provider.test.ts`
Expected: FAIL (module not found / export missing)

- [ ] **Step 3: Implement the helper**

```ts
// packages/app/src/lib/group-catalog-models-by-provider.ts

export type CatalogModelOption = { id: string; name: string }

export type CatalogProviderGroup = {
  providerId: string
  models: CatalogModelOption[]
}

function splitProviderModel(id: string): { providerId: string; modelId: string } | null {
  const trimmed = id.trim()
  if (!trimmed) return null
  const slash = trimmed.indexOf('/')
  if (slash <= 0) return { providerId: trimmed, modelId: trimmed }
  return {
    providerId: trimmed.slice(0, slash),
    modelId: trimmed.slice(slash + 1),
  }
}

export function groupCatalogModelsByProvider(
  models: ReadonlyArray<{ id: string; displayName?: string | null }>,
): CatalogProviderGroup[] {
  const groups: CatalogProviderGroup[] = []
  const byProvider = new Map<string, CatalogProviderGroup>()
  const seen = new Set<string>()

  for (const model of models) {
    const id = model.id?.trim()
    if (!id || seen.has(id)) continue
    seen.add(id)
    const parts = splitProviderModel(id)
    if (!parts) continue
    const name = model.displayName?.trim() || id
    let group = byProvider.get(parts.providerId)
    if (!group) {
      group = { providerId: parts.providerId, models: [] }
      byProvider.set(parts.providerId, group)
      groups.push(group)
    }
    group.models.push({ id, name })
  }

  return groups
}

export function catalogModelsForProvider(
  models: ReadonlyArray<{ id: string; displayName?: string | null }>,
  providerId: string,
): CatalogModelOption[] {
  return groupCatalogModelsByProvider(models).find((g) => g.providerId === providerId)?.models ?? []
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm exec vitest run packages/app/src/lib/__tests__/group-catalog-models-by-provider.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/app/src/lib/group-catalog-models-by-provider.ts \
  packages/app/src/lib/__tests__/group-catalog-models-by-provider.test.ts
git commit -m "$(cat <<'EOF'
feat(app): add catalog model grouping helper for settings LLM

Group OpenCode model-catalog refs by provider so Settings can share
the same provider/model ids and display names as the session picker.
EOF
)"
```

---

### Task 2: Wire `OpenCodeLLMSection` to local daemon model-catalog

**Files:**
- Modify: `packages/app/src/components/settings/LLMSection.tsx`
- Modify: `packages/app/src/components/settings/__tests__/LLMSection.test.tsx`

**Interfaces:**
- Consumes: `groupCatalogModelsByProvider`, `catalogModelsForProvider` from Task 1; `ensureLocalDaemonCatalog`, `useLocalDaemonCatalogStore` from `packages/app/src/stores/local-daemon-catalog-store.ts` (existing `force?: boolean`).
- Produces: Settings model lists derived from catalog; catalog-only providers appear in the list; expand works when catalog has models even if `configured === false`.

- [ ] **Step 1: Extend `LLMSection.test.tsx` mocks and add failing cases**

Add hoisted catalog mock + mock module (alongside existing provider mocks):

```ts
// inside vi.hoisted return + mocks object:
const catalogState = {
  byWorkspacePath: {} as Record<
    string,
    { status: string; models: Array<{ id: string; displayName: string }>; recentModels: string[]; fetchedAt: number }
  >,
}
const ensureLocalDaemonCatalog = vi.fn()

// vi.mock:
vi.mock('@/stores/local-daemon-catalog-store', () => ({
  useLocalDaemonCatalogStore: vi.fn((sel: (s: any) => any) => sel(mocks.catalogState)),
  ensureLocalDaemonCatalog: mocks.ensureLocalDaemonCatalog,
}))
```

In `beforeEach`, reset:

```ts
mocks.catalogState.byWorkspacePath = {}
mocks.ensureLocalDaemonCatalog.mockReset()
```

Add tests:

```ts
it('seeds the local model-catalog on mount for the current workspace', async () => {
  render(<LLMSection />)
  await waitFor(() => {
    expect(mocks.ensureLocalDaemonCatalog).toHaveBeenCalledWith('/test', 'opencode')
  })
})

it('lists catalog models for an unconnected provider and allows expand', async () => {
  mocks.providerState.providers = [{ id: 'opencode', name: 'OpenCode', configured: false }]
  mocks.catalogState.byWorkspacePath['/test'] = {
    status: 'ready',
    models: [
      { id: 'opencode/qwen3.6-plus-free', displayName: 'OpenCode Zen/Qwen3.6 Plus Free' },
    ],
    recentModels: [],
    fetchedAt: Date.now(),
  }

  render(<LLMSection />)

  expect(screen.getByText(/1 model/i)).toBeTruthy()
  // Click the card row (provider name), not Connect — should expand, not only open connect dialog
  fireEvent.click(screen.getByText('OpenCode'))
  expect(await screen.findByText('OpenCode Zen/Qwen3.6 Plus Free')).toBeTruthy()
  expect(screen.getByText('opencode/qwen3.6-plus-free')).toBeTruthy()
})

it('uses catalog display names for a connected provider (not configuredProviders bare ids)', async () => {
  mocks.providerState.providers = [{ id: 'anthropic', name: 'Anthropic', configured: true }]
  mocks.providerState.configuredProviders = [
    { id: 'anthropic', name: 'Anthropic', models: [{ id: 'claude-sonnet-4', name: 'claude-sonnet-4' }] },
  ]
  mocks.catalogState.byWorkspacePath['/test'] = {
    status: 'ready',
    models: [
      { id: 'anthropic/claude-sonnet-4', displayName: 'Claude Sonnet 4' },
    ],
    recentModels: [],
    fetchedAt: Date.now(),
  }

  render(<LLMSection />)
  fireEvent.click(screen.getByText('Anthropic'))
  expect(await screen.findByText('Claude Sonnet 4')).toBeTruthy()
  expect(screen.getByText('anthropic/claude-sonnet-4')).toBeTruthy()
  expect(screen.queryByText('claude-sonnet-4')).toBeNull()
})

it('merges catalog-only providers into the list when /providers omitted them', async () => {
  mocks.providerState.providers = []
  mocks.catalogState.byWorkspacePath['/test'] = {
    status: 'ready',
    models: [{ id: 'opencode/gpt-5-nano', displayName: 'GPT-5 Nano' }],
    recentModels: [],
    fetchedAt: Date.now(),
  }

  render(<LLMSection />)
  expect(screen.getByText('opencode')).toBeTruthy()
  expect(screen.queryByText('No providers available')).toBeNull()
})
```

- [ ] **Step 2: Run the new tests — expect FAIL**

Run: `pnpm exec vitest run packages/app/src/components/settings/__tests__/LLMSection.test.tsx`
Expected: FAIL on catalog seeding / expand / displayName / merge cases

- [ ] **Step 3: Implement wiring in `OpenCodeLLMSection`**

Concrete edits in `packages/app/src/components/settings/LLMSection.tsx`:

1. Imports:

```ts
import {
  catalogModelsForProvider,
  groupCatalogModelsByProvider,
} from '@/lib/group-catalog-models-by-provider'
import {
  ensureLocalDaemonCatalog,
  useLocalDaemonCatalogStore,
} from '@/stores/local-daemon-catalog-store'
```

2. Subscribe to catalog for `workspacePath`:

```ts
const catalogEntry = useLocalDaemonCatalogStore((s) =>
  workspacePath ? s.byWorkspacePath[workspacePath] : undefined,
)
const catalogModels = catalogEntry?.models ?? []
```

3. On mount / workspace change, seed catalog (keep existing provider refresh):

```ts
React.useEffect(() => {
  void refreshAllProviders()
  if (workspacePath) {
    refreshCustomProviderIds(workspacePath)
    ensureLocalDaemonCatalog(workspacePath, 'opencode')
  }
}, [refreshAllProviders, refreshCustomProviderIds, workspacePath])
```

4. Replace `getProviderModels` to use catalog:

```ts
const getProviderModels = (providerId: string) =>
  catalogModelsForProvider(catalogModels, providerId)
```

5. Merge catalog-only providers into the visible list (inside the existing `useMemo` that builds `visibleProviders`, or a preceding memo). For each group from `groupCatalogModelsByProvider(catalogModels)`, if no provider row exists and id !== `TEAM_SHARED_PROVIDER_ID`, append `{ id, name: id, configured: false }` (prefer a nicer name if `providers` later gains one). Treat providers that have catalog models like “visible” even when not mainstream — put them in `connected` if configured, else in `mainstream` when they have models so free OpenCode is not buried behind “Show more”.

6. Expand / click behavior:

```ts
const canExpandProvider = (providerId: string, configured: boolean) =>
  configured || catalogModelsForProvider(catalogModels, providerId).length > 0

const handleProviderClick = (providerId: string, configured: boolean, providerName: string) => {
  if (canExpandProvider(providerId, configured)) {
    setSelectedProviderId(selectedProviderId === providerId ? null : providerId)
    return
  }
  handleConnectClick(providerId, providerName)
}
```

7. In the card render loop:
   - `const models = getProviderModels(p.id)` for both connected and catalog-backed unconnected
   - Subtitle: if `models.length > 0`, show models-available count; else if connected show 0 models; else “Not connected”
   - Show chevron when `canExpandProvider(...)`
   - Expanded block: `canExpandProvider && isExpanded && models.length > 0` (not `isConnected && ...`)
   - Keep Connect button for `!isConnected`; Connected badge only when `isConnected`

Stop using `configuredProviders` for the OpenCode model list UI (the store subscription can remain unused or be removed from this component if nothing else needs it — remove the unused selector to avoid lint noise).

- [ ] **Step 4: Re-run LLMSection tests**

Run: `pnpm exec vitest run packages/app/src/components/settings/__tests__/LLMSection.test.tsx`
Expected: PASS (including pre-existing OAuth / custom provider tests)

- [ ] **Step 5: Commit**

```bash
git add packages/app/src/components/settings/LLMSection.tsx \
  packages/app/src/components/settings/__tests__/LLMSection.test.tsx
git commit -m "$(cat <<'EOF'
feat(settings): show OpenCode LLM models from model-catalog

Settings LLM Model expands the same loopback catalog the session
picker uses, including free/unconnected providers, while Connect
still goes through /providers.
EOF
)"
```

---

### Task 3: Force catalog refetch after auth / refresh actions

**Files:**
- Modify: `packages/app/src/components/settings/LLMSection.tsx`
- Modify: `packages/app/src/components/settings/__tests__/LLMSection.test.tsx`

**Interfaces:**
- Consumes: `ensureLocalDaemonCatalog(path, 'opencode', { force: true })`
- Produces: After Connect success, Disconnect success, custom add/edit/remove success, and the section Refresh button, catalog is force-refetched so new models appear without waiting for the 5-minute ready TTL.

- [ ] **Step 1: Write failing test for refresh + connect paths**

```ts
it('force-refetches model-catalog when the refresh control is used', async () => {
  mocks.providerState.providers = [{ id: 'openai', name: 'OpenAI', configured: true }]
  render(<LLMSection />)
  mocks.ensureLocalDaemonCatalog.mockClear()

  fireEvent.click(screen.getByRole('button', { name: /refresh/i }))
  await waitFor(() => {
    expect(mocks.ensureLocalDaemonCatalog).toHaveBeenCalledWith('/test', 'opencode', {
      force: true,
    })
  })
})
```

If the Refresh control’s accessible name differs, match the existing button label in `LLMSection.tsx` (search for `handleRefreshProviders` / refresh icon button `title` / `aria-label`).

Also add (or fold into an existing connect success path if one exists): after `connectProvider` resolves true and dialog closes, expect `ensureLocalDaemonCatalog('/test', 'opencode', { force: true })`. Mirror for disconnect if a simple path is testable with current mocks.

- [ ] **Step 2: Run test — expect FAIL**

Run: `pnpm exec vitest run packages/app/src/components/settings/__tests__/LLMSection.test.tsx -t 'force-refetches'`
Expected: FAIL (force not called)

- [ ] **Step 3: Implement force refetch**

Add a small helper inside the component:

```ts
const refreshModelCatalog = React.useCallback(() => {
  if (!workspacePath) return
  ensureLocalDaemonCatalog(workspacePath, 'opencode', { force: true })
}, [workspacePath])
```

Call it from:
- `handleRefreshProviders` after `refreshAllProviders` / custom ids refresh
- Successful `connectProvider` / OAuth complete paths (wherever `refreshAllProviders` is already awaited after success)
- Successful `disconnectProvider`
- Successful custom provider add / update / remove

Do **not** pass `{ force: true }` on the initial mount effect (TTL-friendly first load is fine).

- [ ] **Step 4: Re-run LLMSection tests**

Run: `pnpm exec vitest run packages/app/src/components/settings/__tests__/LLMSection.test.tsx`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/app/src/components/settings/LLMSection.tsx \
  packages/app/src/components/settings/__tests__/LLMSection.test.tsx
git commit -m "$(cat <<'EOF'
fix(settings): refresh model-catalog after LLM provider auth changes

Force-refetch the loopback catalog after connect/disconnect/custom
edits and the refresh control so Settings stays aligned with chat.
EOF
)"
```

---

### Task 4: Spec status + smoke verification

**Files:**
- Modify: `docs/superpowers/specs/2026-08-11-opencode-settings-model-catalog-design.md` (Status line only)

- [ ] **Step 1: Run focused verification**

```bash
pnpm exec vitest run \
  packages/app/src/lib/__tests__/group-catalog-models-by-provider.test.ts \
  packages/app/src/components/settings/__tests__/LLMSection.test.tsx
```

Expected: all PASS

- [ ] **Step 2: Update spec status**

Change `Status: Draft (awaiting review)` → `Status: Implemented`

- [ ] **Step 3: Commit**

```bash
git add -f docs/superpowers/specs/2026-08-11-opencode-settings-model-catalog-design.md
git commit -m "$(cat <<'EOF'
docs: mark OpenCode settings model-catalog design implemented
EOF
)"
```

---

## Spec coverage checklist

| Spec requirement | Task |
|---|---|
| Settings models from `model-catalog` / local-daemon-catalog-store | Task 2 |
| Keep `/providers` for connection only | Task 2 (no daemon change) |
| Same `provider/model` ids + displayNames | Task 1 + 2 |
| Unconnected catalog providers expandable (free OpenCode) | Task 2 |
| Force refetch after auth / refresh | Task 3 |
| Helper unit tests + LLMSection tests | Task 1–3 |
| Team Shared LLM pane untouched | (no task) |
| Session picker untouched | (no task) |

## Self-review notes

- No placeholders / TBD left in tasks.
- `ensureLocalDaemonCatalog` already supports `{ force: true }` — no store API change required.
- Catalog-only provider merge is required; otherwise free `opencode` never appears if `/providers` omits it.
- `configuredProviders` remains in the provider store for cron/other callers; Settings OpenCode UI stops reading it for models.

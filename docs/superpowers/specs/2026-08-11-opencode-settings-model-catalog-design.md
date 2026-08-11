# OpenCode Settings Model Catalog Alignment — Design

Date: 2026-08-11
Status: Implemented

## Goal

Make **Settings → LLM Model** show the same selectable models as the **session
model picker** when the local runtime is OpenCode: same source, same
`provider/model` ids, same display names.

Provider **connection management** (Connect / Disconnect / OAuth / custom
providers) stays on the existing `/providers` path.

## Problem

Today the two UIs use different catalogs:

| Surface | Source | Filter |
|---|---|---|
| Settings → LLM Model | daemon `GET /providers` (`opencode.json` + OpenCode `GET /provider` connected set) | Only `authenticated` providers expand models |
| Session picker | OpenCode `GET /config/providers` → `RuntimeInfo.availableModels` / loopback `model-catalog` | Full runtime catalog |

Result: settings misses built-in / free OpenCode models, uses bare model ids,
and can disagree with chat even for connected providers.

## Decisions (locked)

- **Direction A:** Settings shows the full session-equivalent model list;
  connection management is retained, not removed.
- **Authoritative model source for Settings:** local loopback
  `GET /v1/workspaces/:id/model-catalog` (OpenCode group), via the existing
  `local-daemon-catalog-store` / `ensureLocalDaemonCatalog` path — **not** MQTT
  retain, **not** `configuredProviders` from `/providers`.
- **Connection source unchanged:** `GET /v1/workspaces/:id/providers` +
  `useProviderStore.providers[].configured`.
- **No daemon contract change** to `/providers`. Reuse `model-catalog` as the
  single model list already used by draft/local session UI.
- **Team Shared LLM pane** (LiteLLM admin UI) is out of scope.
- **Session picker logic** is out of scope (already correct for this goal).

## Data flow

```
OpenCode serve GET /config/providers
        │
        ▼
daemon GET /v1/workspaces/:id/model-catalog
        │
        ├── Session draft / local agent pill  (existing)
        └── Settings → LLM Model              (this change)

daemon GET /v1/workspaces/:id/providers
        └── Settings provider cards (connected / connect / disconnect)
```

Settings consumes **both**: catalog for models, providers for auth state.

## Frontend design

### Helper

Add a pure helper (e.g. `groupCatalogModelsByProvider` under
`packages/app/src/lib/`):

- **Input:** `ModelInfo[]` (or `{ id, displayName }[]`) where `id` is
  `provider/model`.
- **Output:** `Map` or array of `{ providerId, models: [{ id: fullRef, name: displayName }] }`.
- Preserve daemon order; dedupe by full ref; ignore blank ids.

### `OpenCodeLLMSection`

1. On mount / workspace change: call
   `ensureLocalDaemonCatalog(workspacePath, 'opencode')` (same store the chat
   draft path uses).
2. Derive per-provider model lists from the catalog entry for the current
   workspace, **not** from `configuredProviders`.
3. Keep using `useProviderStore` for provider rows, connect/disconnect, OAuth,
   and custom provider CRUD.
4. After successful connect / disconnect / custom add-edit-remove: refresh
   providers **and** force a catalog refetch (bypass the ready TTL so the new
   models appear immediately).

### UI rules

| Provider state | Model list | Card chrome |
|---|---|---|
| `configured === true` | From catalog for that provider id | Connected + expand chevron |
| Catalog has models, not configured (e.g. free `opencode` Zen) | From catalog; expandable | No forced Connect; show available count; Connect still offered if auth methods exist |
| Not configured and catalog empty for that id | Empty | Connect only |
| Catalog `pending` | Empty / loading subtitle | Unchanged cards |
| Catalog `empty` / `error` / `unknown` | Empty; optional muted hint | Connection UI still works |

Expanded row shows **displayName** primary and full `provider/model` id as
secondary (mono / muted), matching session identity.

`TEAM_SHARED_PROVIDER_ID` remains a pinned card outside this list (existing
behavior); its models continue to come from team config / materialization, not
this change’s primary path. If the catalog already includes `team/...` models,
showing them under the team card when expanded is allowed as long as membership
still treats cloud/daemon team config as authoritative for connect state.

### Store notes

- Prefer reading `useLocalDaemonCatalogStore` over duplicating fetch logic in
  `useProviderStore`.
- `configuredProviders` / `refreshConfiguredProviders` may remain for cron and
  other callers in this change; Settings OpenCode section stops treating them
  as the model authority. A follow-up may retire the settings dependency
  entirely — not required here.

## Testing

- Unit: `groupCatalogModelsByProvider` — grouping, dedupe, empty input, ids
  without `/`.
- Unit / component: when catalog contains `opencode/foo` and provider
  `opencode` is not `configured`, the OpenCode card still lists the model.
- Unit / component: connected provider uses catalog `displayName`, not bare
  model id from `/providers`.
- After connect success mock: catalog refetch is triggered (spy on
  `ensureLocalDaemonCatalog` / store force path).

No new daemon integration tests unless a missing catalog field blocks the UI
(unexpected).

## Risks

- Settings requires a reachable local daemon for the model list — same as the
  draft session path; acceptable.
- Brief mismatch vs an already-attached session’s MQTT retain is possible;
  Settings intentionally follows loopback catalog (draft parity). Attached
  chat remains retain-first.
- Forcing catalog refetch on every auth change may hit OpenCode
  `/config/providers` more often; cost is small and matches user expectation
  after Connect.

## Out of scope

- Changing session `resolveAgentCatalogModels` / retain precedence.
- Rewriting `/providers` to return full `/config/providers`.
- Team LiteLLM admin model multi-select UX.
- Non-OpenCode settings sections (if any) beyond the shared helper reuse.

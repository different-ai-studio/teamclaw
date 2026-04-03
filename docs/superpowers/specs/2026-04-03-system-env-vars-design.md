# System Environment Variables

**Date:** 2026-04-03
**Status:** Draft

## Problem

Team mode API key (`tc_api_key`) is currently injected via `connectProvider` HTTP call **after** opencode starts, and stored in browser localStorage. This causes:

1. **Sidebar refresh loses auth** — `reAuthTeamProvider` silently fails when localStorage clears or `getDeviceNodeId()` isn't ready
2. **Race conditions** — auth depends on webview lifecycle, not sidecar lifecycle
3. **No extensibility** — future default env vars (e.g. gateway tokens) would need similar fragile plumbing
4. **macOS Keychain prompt spam** — each env var is a separate keychain entry with its own authorization prompt

## Solution

Two improvements combined:

1. **Single keychain blob** — all personal env vars stored in one keychain entry as a JSON object, so macOS only prompts once per session
2. **System env var category** — a built-in registry of env vars with default value generators, injected at startup, not deletable by users

## Design

### 1. Single Keychain Blob Storage

**Before:** each key gets its own keychain entry
```
teamclaw.env.MY_KEY_1   → "val1"
teamclaw.env.MY_KEY_2   → "val2"
teamclaw.env.tc_api_key → "sk-tc-..."
```
Result: N keys = up to N macOS authorization prompts per session.

**After:** all personal env vars stored in one keychain entry
```
teamclaw.env  →  {"MY_KEY_1": "val1", "MY_KEY_2": "val2", "tc_api_key": "sk-tc-..."}
```
Result: 1 prompt per session regardless of how many keys exist.

**CRUD operations** become read-modify-write on the JSON blob:
- `env_var_set(key, value)` → read blob → set `blob[key] = value` → write blob
- `env_var_get(key)` → read blob → return `blob[key]`
- `env_var_delete(key)` → read blob → remove `blob[key]` → write blob

The keychain service name changes from `teamclaw.env.<KEY>` to just `teamclaw.env`.

**Migration:** on first access, detect old-format entries (`teamclaw.env.<KEY>`) in teamclaw.json, read them all into the new blob, delete the old entries. One-time, transparent.

### 2. Data Model Changes

#### Rust: `EnvVarEntry` gains `category`

```rust
// env_vars.rs
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EnvVarEntry {
    pub key: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub category: Option<String>,  // "system" | null (user)
}
```

Stored in `teamclaw.json` (index only, no values):
```json
{
  "envVars": [
    { "key": "tc_api_key", "description": "Team LLM API Key", "category": "system" },
    { "key": "MY_CUSTOM_KEY", "description": "user added" }
  ]
}
```

Values live only in the single keychain blob — not in teamclaw.json.

#### TypeScript: same addition

```typescript
export interface EnvVarEntry {
  key: string
  description?: string
  category?: 'system' | null
}
```

### 3. System Env Var Registry (Rust)

A static list in `env_vars.rs` defining all system env vars and their default value generators:

```rust
struct SystemEnvVarDef {
    key: &'static str,
    description: &'static str,
    default_fn: fn(&SystemEnvVarContext) -> Option<String>,
}

struct SystemEnvVarContext {
    device_id: String,  // from get_or_create_fallback_device_id()
}

const SYSTEM_ENV_VARS: &[SystemEnvVarDef] = &[
    SystemEnvVarDef {
        key: "tc_api_key",
        description: "Team LLM API Key",
        default_fn: |ctx| {
            if ctx.device_id.is_empty() { return None; }
            Some(format!("sk-tc-{}", &ctx.device_id[..ctx.device_id.len().min(40)]))
        },
    },
    // Future: add more system env vars here
];
```

### 4. Startup Flow (`opencode.rs`)

```
opencode startup
  ↓
ensure_system_env_vars(workspace_path, device_id)
  → read blob from keychain (single prompt if needed)
  → for each SYSTEM_ENV_VARS entry:
      → if blob[key] missing or empty → generate default → write blob + update teamclaw.json index
      → if present → skip (user may have customized)
  ↓
read_keyring_secrets(workspace_path)   ← unchanged, reads same blob, expands to Vec<(String, String)>
  ↓
inject all as process env vars → spawn opencode sidecar
```

`read_keyring_secrets` changes: instead of reading N separate keychain entries, it reads the single `teamclaw.env` blob and expands it into `Vec<(String, String)>`.

### 5. Team Mode Changes (`team-mode.ts`)

**Remove:**
- `connectProvider(TEAM_PROVIDER_ID, apiKey)` call in `applyTeamModelToOpenCode`
- `reAuthTeamProvider()` function entirely
- `teamApiKey` state field and localStorage persistence
- `setTeamApiKey` action
- `getPersistedTeamApiKey()` helper

**Keep:**
- `addCustomProviderToConfig` — still writes team provider with baseURL to opencode.json
- Team provider config references `${tc_api_key}` which gets resolved at startup

**Provider config in opencode.json** after this change:
```json
{
  "providers": {
    "team": {
      "baseURL": "https://...",
      "apiKey": "${tc_api_key}",
      "models": [...]
    }
  }
}
```
`resolve_config_secret_refs` resolves `${tc_api_key}` from the blob at startup — same mechanism as MCP env vars.

### 6. `env_var_delete` Guard

Refuse to delete keys with `category: "system"` in teamclaw.json index. Returns an error like `"System variable 'tc_api_key' cannot be deleted"`.

### 7. UI Changes (`EnvVarsSection.tsx`)

- System entries show a **lock icon** + "System" badge instead of Personal/Team badge
- **Delete button hidden** for system entries
- **Edit button enabled** — user can override the default value
- System entries sorted first in the list
- UI behavior is otherwise identical — still shows one row per key

## Files to Modify

| File | Change |
|------|--------|
| `src-tauri/src/commands/env_vars.rs` | Single blob storage, migration, `category` field, system registry, `ensure_system_env_vars()`, delete guard |
| `src-tauri/src/commands/opencode.rs` | Call `ensure_system_env_vars` before keyring read; update `read_keyring_secrets` for blob format |
| `packages/app/src/stores/env-vars.ts` | Add `category` to `EnvVarEntry` |
| `packages/app/src/stores/team-mode.ts` | Remove `connectProvider`, `reAuthTeamProvider`, `teamApiKey` |
| `packages/app/src/components/settings/EnvVarsSection.tsx` | System badge, hide delete for system entries |
| `packages/app/src/components/chat/ChatPanel.tsx` | Remove `reAuthTeamProvider` call |

## Out of Scope

- Changes to shared/team secrets — only personal env vars get the `system` category and blob storage
- opencode provider config format changes beyond adding `${tc_api_key}` reference
- Migration of existing users' localStorage `teamApiKey` — system env var auto-generates the same default value so no action needed

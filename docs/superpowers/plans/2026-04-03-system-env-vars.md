# System Env Vars Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace per-key keychain storage with a single blob, add a system env var category with a Rust registry, and remove fragile team-mode auth logic that depends on webview/localStorage.

**Architecture:** All personal env vars are merged into one JSON blob stored under a single keychain entry (`teamclaw.env`), eliminating per-key macOS authorization prompts. A static `SYSTEM_ENV_VARS` registry in Rust auto-generates default values (like `tc_api_key`) at startup if missing. The team provider reads its API key via `${tc_api_key}` resolved from the blob at opencode startup — no more HTTP `connectProvider` calls after startup.

**Tech Stack:** Rust (keyring crate, serde_json), TypeScript/React (Zustand, Tauri invoke), Tauri v2

---

## File Map

| File | What changes |
|------|--------------|
| `src-tauri/src/commands/env_vars.rs` | Blob storage helpers, migration, `category` field, system registry, `ensure_system_env_vars`, delete guard |
| `src-tauri/src/commands/opencode.rs` | Call `ensure_system_env_vars` pre-startup; update `read_keyring_secrets` for blob format |
| `packages/app/src/lib/opencode/config.ts` | Add `apiKey?: string` to `CustomProviderConfig`; write it into `options` |
| `packages/app/src/stores/team-mode.ts` | Remove `connectProvider`, `reAuthTeamProvider`, `teamApiKey`, `setTeamApiKey`, `getPersistedTeamApiKey`; pass `apiKey: '${tc_api_key}'` to provider config |
| `packages/app/src/components/chat/ChatPanel.tsx` | Remove `reAuthTeamProvider` and `teamApiKey` from init logic; simplify `configKey` |
| `packages/app/src/stores/env-vars.ts` | Add `category?: 'system' \| null` to `EnvVarEntry` |
| `packages/app/src/components/settings/EnvVarsSection.tsx` | System badge + lock icon; hide delete for system entries |

---

### Task 1: Blob storage helpers in env_vars.rs

**Files:**
- Modify: `src-tauri/src/commands/env_vars.rs`

The keychain entry `teamclaw.env` (service) / `teamclaw` (username) stores a JSON object as its password. All reads and writes go through two helpers: `read_env_blob` and `write_env_blob`. Migration from old per-key entries runs inside `read_env_blob` on first call.

- [ ] **Step 1: Add blob constants and helpers**

In `src-tauri/src/commands/env_vars.rs`, replace the existing `KEYRING_SERVICE_PREFIX` constant and `keyring_service` function with:

```rust
/// Single keychain entry that stores all env vars as a JSON blob.
pub(crate) const KEYRING_SERVICE: &str = concat!(env!("APP_SHORT_NAME"), ".env");

/// Legacy per-key service prefix (used only for migration detection).
const LEGACY_SERVICE_PREFIX: &str = concat!(env!("APP_SHORT_NAME"), ".env");

/// Read the entire env var blob from keychain.
/// Returns an empty map if the entry doesn't exist yet.
/// On first call after migration: detects old per-key entries and consolidates them.
pub(crate) fn read_env_blob(workspace_path: &str) -> Result<serde_json::Map<String, serde_json::Value>, String> {
    let entry = keyring::Entry::new(KEYRING_SERVICE, "teamclaw")
        .map_err(|e| format!("Failed to open keychain entry: {}", e))?;

    match entry.get_password() {
        Ok(json_str) => {
            let val: serde_json::Value = serde_json::from_str(&json_str)
                .unwrap_or(serde_json::Value::Object(serde_json::Map::new()));
            match val {
                serde_json::Value::Object(map) => Ok(map),
                _ => Ok(serde_json::Map::new()),
            }
        }
        Err(keyring::Error::NoEntry) => {
            // First launch: attempt migration from legacy per-key format
            let migrated = migrate_legacy_keyring(workspace_path);
            if !migrated.is_empty() {
                println!("[EnvVars] Migrated {} legacy keychain entries to blob", migrated.len());
                write_env_blob(&migrated)?;
            }
            Ok(migrated)
        }
        Err(e) => Err(format!("Failed to read keychain blob: {}", e)),
    }
}

/// Write the entire env var blob to keychain.
pub(crate) fn write_env_blob(map: &serde_json::Map<String, serde_json::Value>) -> Result<(), String> {
    let json_str = serde_json::to_string(map)
        .map_err(|e| format!("Failed to serialize env blob: {}", e))?;
    let entry = keyring::Entry::new(KEYRING_SERVICE, "teamclaw")
        .map_err(|e| format!("Failed to open keychain entry: {}", e))?;
    entry.set_password(&json_str)
        .map_err(|e| format!("Failed to write keychain blob: {}", e))
}

/// Read old per-key keychain entries and consolidate into a map.
/// Deletes old entries after reading.
fn migrate_legacy_keyring(workspace_path: &str) -> serde_json::Map<String, serde_json::Value> {
    let path = format!("{}/{}/teamclaw.json", workspace_path, super::TEAMCLAW_DIR);
    let json: serde_json::Value = match std::fs::read_to_string(&path)
        .ok()
        .and_then(|c| serde_json::from_str(&c).ok())
    {
        Some(v) => v,
        None => return serde_json::Map::new(),
    };

    let entries = match json.get("envVars").and_then(|v| v.as_array()) {
        Some(arr) => arr.clone(),
        None => return serde_json::Map::new(),
    };

    let mut map = serde_json::Map::new();
    for entry_val in &entries {
        let key = match entry_val.get("key").and_then(|k| k.as_str()) {
            Some(k) => k,
            None => continue,
        };
        // Legacy service name was "teamclaw.env.<KEY>"
        let legacy_service = format!("{}.{}", LEGACY_SERVICE_PREFIX, key);
        if let Ok(e) = keyring::Entry::new(&legacy_service, "teamclaw") {
            if let Ok(value) = e.get_password() {
                map.insert(key.to_string(), serde_json::Value::String(value));
                // Delete old entry
                let _ = e.delete_credential();
            }
        }
    }
    map
}
```

- [ ] **Step 2: Verify the project builds**

```bash
cd /Volumes/openbeta/workspace/teamclaw && cargo build -p teamclaw 2>&1 | tail -20
```
Expected: no errors (warnings ok).

- [ ] **Step 3: Commit**

```bash
cd /Volumes/openbeta/workspace/teamclaw
git add src-tauri/src/commands/env_vars.rs
git commit -m "feat(env-vars): add single-blob keychain helpers with legacy migration"
```

---

### Task 2: Update CRUD commands to use blob

**Files:**
- Modify: `src-tauri/src/commands/env_vars.rs`

Replace the per-key keyring calls in `env_var_set`, `env_var_get`, and `env_var_delete` with blob read-modify-write.

- [ ] **Step 1: Update `env_var_set`**

Replace the existing `env_var_set` function body:

```rust
#[tauri::command]
pub async fn env_var_set(
    state: State<'_, OpenCodeState>,
    key: String,
    value: String,
    description: Option<String>,
) -> Result<(), String> {
    let workspace_path = get_workspace_path(&state)?;

    // Read-modify-write the blob
    let mut blob = tokio::task::spawn_blocking({
        let wp = workspace_path.clone();
        move || read_env_blob(&wp)
    }).await.map_err(|e| e.to_string())??;

    blob.insert(key.clone(), serde_json::Value::String(value));
    write_env_blob(&blob)?;

    // Update index in teamclaw.json (metadata only, no value)
    let mut json = read_teamclaw_json(&workspace_path)?;
    let mut entries = get_env_vars_from_json(&json);

    if let Some(existing) = entries.iter_mut().find(|e| e.key == key) {
        existing.description = description;
    } else {
        entries.push(EnvVarEntry { key, description, category: None });
    }

    set_env_vars_in_json(&mut json, &entries);
    write_teamclaw_json(&workspace_path, &json)
}
```

- [ ] **Step 2: Update `env_var_get`**

Replace the existing `env_var_get` function body:

```rust
#[tauri::command]
pub async fn env_var_get(
    state: State<'_, OpenCodeState>,
    key: String,
) -> Result<String, String> {
    let workspace_path = get_workspace_path(&state)?;
    let blob = tokio::task::spawn_blocking({
        let wp = workspace_path.clone();
        move || read_env_blob(&wp)
    }).await.map_err(|e| e.to_string())??;

    blob.get(&key)
        .and_then(|v| v.as_str())
        .map(|s| s.to_string())
        .ok_or_else(|| format!("Key '{}' not found", key))
}
```

Note: `env_var_get` previously took only `key: String`. It now also takes `state` — update the Tauri command registration in `src-tauri/src/lib.rs` if the signature is listed there (it's registered as `env_var_get` — check it takes the new parameter automatically via Tauri's state injection).

- [ ] **Step 3: Update `env_var_delete`**

Replace the existing `env_var_delete` function body:

```rust
#[tauri::command]
pub async fn env_var_delete(state: State<'_, OpenCodeState>, key: String) -> Result<(), String> {
    let workspace_path = get_workspace_path(&state)?;

    // Check category in index — system vars cannot be deleted
    let json = read_teamclaw_json(&workspace_path)?;
    let entries = get_env_vars_from_json(&json);
    if let Some(entry) = entries.iter().find(|e| e.key == key) {
        if entry.category.as_deref() == Some("system") {
            return Err(format!("System variable '{}' cannot be deleted", key));
        }
    }

    // Read-modify-write the blob
    let mut blob = tokio::task::spawn_blocking({
        let wp = workspace_path.clone();
        move || read_env_blob(&wp)
    }).await.map_err(|e| e.to_string())??;

    blob.remove(&key);
    write_env_blob(&blob)?;

    // Remove from teamclaw.json index
    let mut json = read_teamclaw_json(&workspace_path)?;
    let mut entries = get_env_vars_from_json(&json);
    entries.retain(|e| e.key != key);
    set_env_vars_in_json(&mut json, &entries);
    write_teamclaw_json(&workspace_path, &json)
}
```

- [ ] **Step 4: Build to verify**

```bash
cd /Volumes/openbeta/workspace/teamclaw && cargo build -p teamclaw 2>&1 | tail -20
```
Expected: no errors.

- [ ] **Step 5: Commit**

```bash
cd /Volumes/openbeta/workspace/teamclaw
git add src-tauri/src/commands/env_vars.rs
git commit -m "feat(env-vars): migrate CRUD commands to single blob keychain storage"
```

---

### Task 3: Add `category` field, system registry, `ensure_system_env_vars`

**Files:**
- Modify: `src-tauri/src/commands/env_vars.rs`

- [ ] **Step 1: Add `category` field to `EnvVarEntry`**

Replace the existing `EnvVarEntry` struct:

```rust
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EnvVarEntry {
    pub key: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub category: Option<String>,  // "system" | None
}
```

- [ ] **Step 2: Add system registry and `ensure_system_env_vars`**

Add these after the `KEYRING_SERVICE` constant at the top of `env_vars.rs`:

```rust
/// Context available to system env var default generators.
pub(crate) struct SystemEnvVarContext {
    pub device_id: String,
}

/// Definition of a system-managed env var.
pub(crate) struct SystemEnvVarDef {
    pub key: &'static str,
    pub description: &'static str,
    pub default_fn: fn(&SystemEnvVarContext) -> Option<String>,
}

/// Registry of all system env vars.
/// To add a new one: append an entry here — nothing else changes.
pub(crate) const SYSTEM_ENV_VARS: &[SystemEnvVarDef] = &[
    SystemEnvVarDef {
        key: "tc_api_key",
        description: "Team LLM API Key",
        default_fn: |ctx| {
            if ctx.device_id.is_empty() {
                return None;
            }
            let id = &ctx.device_id;
            Some(format!("sk-tc-{}", &id[..id.len().min(40)]))
        },
    },
];

/// Ensure all system env vars exist in keychain and in the teamclaw.json index.
/// If a key is missing from the blob, its default value is generated and written.
/// If a key already has a value (user customized), it is left unchanged.
/// This must be called on a blocking thread (keychain I/O).
pub(crate) fn ensure_system_env_vars(
    workspace_path: &str,
    device_id: &str,
) -> Result<(), String> {
    let ctx = SystemEnvVarContext { device_id: device_id.to_string() };
    let mut blob = read_env_blob(workspace_path)?;
    let mut json = read_teamclaw_json(workspace_path)?;
    let mut entries = get_env_vars_from_json(&json);
    let mut blob_changed = false;
    let mut index_changed = false;

    for def in SYSTEM_ENV_VARS {
        // Generate default value if not already set
        if !blob.contains_key(def.key) || blob[def.key].as_str().map_or(true, |v| v.is_empty()) {
            if let Some(default_value) = (def.default_fn)(&ctx) {
                blob.insert(def.key.to_string(), serde_json::Value::String(default_value));
                blob_changed = true;
                println!("[EnvVars] Generated default value for system var: {}", def.key);
            }
        }

        // Ensure index entry exists with category: "system"
        if let Some(existing) = entries.iter_mut().find(|e| e.key == def.key) {
            if existing.category.as_deref() != Some("system") {
                existing.category = Some("system".to_string());
                index_changed = true;
            }
        } else {
            entries.push(EnvVarEntry {
                key: def.key.to_string(),
                description: Some(def.description.to_string()),
                category: Some("system".to_string()),
            });
            index_changed = true;
        }
    }

    if blob_changed {
        write_env_blob(&blob)?;
    }
    if index_changed {
        set_env_vars_in_json(&mut json, &entries);
        write_teamclaw_json(workspace_path, &json)?;
    }

    Ok(())
}
```

- [ ] **Step 3: Build to verify**

```bash
cd /Volumes/openbeta/workspace/teamclaw && cargo build -p teamclaw 2>&1 | tail -20
```
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
cd /Volumes/openbeta/workspace/teamclaw
git add src-tauri/src/commands/env_vars.rs
git commit -m "feat(env-vars): add system env var registry and ensure_system_env_vars"
```

---

### Task 4: Update opencode.rs startup

**Files:**
- Modify: `src-tauri/src/commands/opencode.rs`

Two changes: (1) call `ensure_system_env_vars` before the parallel block, (2) update `read_keyring_secrets` to use the blob.

- [ ] **Step 1: Update `read_keyring_secrets` to use blob**

Replace the entire `read_keyring_secrets` function (lines ~1080–1121):

```rust
/// Read all personal env vars from the single keychain blob.
/// Returns `(secrets, failed)` — failed is empty on success, or contains
/// a diagnostic message if the blob itself cannot be read.
fn read_keyring_secrets(workspace_path: &str) -> (Vec<(String, String)>, Vec<String>) {
    match super::env_vars::read_env_blob(workspace_path) {
        Ok(blob) => {
            let secrets: Vec<(String, String)> = blob
                .into_iter()
                .filter_map(|(k, v)| v.as_str().map(|s| (k, s.to_string())))
                .collect();
            println!("[OpenCode] Loaded {} secrets from keychain blob", secrets.len());
            (secrets, Vec::new())
        }
        Err(e) => {
            eprintln!("[OpenCode] Failed to read keychain blob: {}", e);
            (Vec::new(), vec!["__blob__".to_string()])
        }
    }
}
```

- [ ] **Step 2: Call `ensure_system_env_vars` before the parallel startup block**

In `start_opencode`, find the line:
```rust
let ws_for_config = workspace_path.clone();
```

Insert before it:

```rust
// Ensure system env vars exist (e.g. tc_api_key) before reading keyring secrets.
// This runs synchronously — it's fast (one keychain read + optional write).
{
    let device_id = super::oss_commands::get_or_create_fallback_device_id()
        .unwrap_or_default();
    let ws = workspace_path.clone();
    let did = device_id.clone();
    if let Err(e) = tokio::task::spawn_blocking(move || {
        super::env_vars::ensure_system_env_vars(&ws, &did)
    }).await.map_err(|e| e.to_string()).and_then(|r| r.map_err(|e| e)) {
        eprintln!("[OpenCode] Warning: failed to ensure system env vars: {}", e);
    }
}
```

- [ ] **Step 3: Build to verify**

```bash
cd /Volumes/openbeta/workspace/teamclaw && cargo build -p teamclaw 2>&1 | tail -20
```
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
cd /Volumes/openbeta/workspace/teamclaw
git add src-tauri/src/commands/opencode.rs
git commit -m "feat(opencode): inject system env vars and use blob for keychain secrets at startup"
```

---

### Task 5: Add apiKey support to provider config

**Files:**
- Modify: `packages/app/src/lib/opencode/config.ts`

The team provider config in opencode.json needs `options.apiKey: "${tc_api_key}"` so `resolve_config_secret_refs` substitutes the real value before opencode starts.

- [ ] **Step 1: Add `apiKey` to `CustomProviderConfig`**

In `config.ts`, replace:

```typescript
export interface CustomProviderConfig {
  name: string
  baseURL: string
  models: CustomModelConfig[]
}
```

With:

```typescript
export interface CustomProviderConfig {
  name: string
  baseURL: string
  apiKey?: string
  models: CustomModelConfig[]
}
```

- [ ] **Step 2: Write `apiKey` into the provider options in `addCustomProviderToConfig`**

In `addCustomProviderToConfig`, replace:

```typescript
  openCodeConfig.provider[providerId] = {
    npm: '@ai-sdk/openai-compatible',
    name: config.name,
    options: {
      baseURL: config.baseURL,
    },
    models: modelsObj,
  }
```

With:

```typescript
  const providerOptions: { baseURL: string; apiKey?: string } = {
    baseURL: config.baseURL,
  }
  if (config.apiKey) {
    providerOptions.apiKey = config.apiKey
  }

  openCodeConfig.provider[providerId] = {
    npm: '@ai-sdk/openai-compatible',
    name: config.name,
    options: providerOptions,
    models: modelsObj,
  }
```

Also apply the same pattern in `updateCustomProviderConfig` (same block, around line 238):

```typescript
  const providerOptions: { baseURL: string; apiKey?: string } = {
    baseURL: config.baseURL,
  }
  if (config.apiKey) {
    providerOptions.apiKey = config.apiKey
  }

  openCodeConfig.provider[providerId] = {
    npm: '@ai-sdk/openai-compatible',
    name: config.name,
    options: providerOptions,
    models: modelsObj,
  }
```

- [ ] **Step 3: Build to verify TypeScript compiles**

```bash
cd /Volumes/openbeta/workspace/teamclaw/packages/app && npx tsc --noEmit 2>&1 | head -30
```
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
cd /Volumes/openbeta/workspace/teamclaw
git add packages/app/src/lib/opencode/config.ts
git commit -m "feat(config): add optional apiKey to CustomProviderConfig"
```

---

### Task 6: Clean up team-mode.ts

**Files:**
- Modify: `packages/app/src/stores/team-mode.ts`

Remove all localStorage-based auth logic. Pass `apiKey: '${tc_api_key}'` when writing the team provider config so opencode resolves it from the env var blob at startup.

- [ ] **Step 1: Remove `TEAM_API_KEY_STORAGE` import and `getPersistedTeamApiKey`**

Remove the import line:
```typescript
import { appShortName, buildConfig, TEAM_API_KEY_STORAGE_KEY } from '@/lib/build-config'
```
Replace with (drop `TEAM_API_KEY_STORAGE_KEY` and `appShortName` if no longer used):
```typescript
import { buildConfig } from '@/lib/build-config'
```

Remove the constants and function:
```typescript
const TEAM_API_KEY_STORAGE = TEAM_API_KEY_STORAGE_KEY

export function getPersistedTeamApiKey(): string | null {
  try {
    return localStorage.getItem(TEAM_API_KEY_STORAGE) || null
  } catch {
    return null
  }
}
```

- [ ] **Step 2: Remove `teamApiKey` and `setTeamApiKey` from state interface and store**

In `TeamModeState` interface, remove:
```typescript
  teamApiKey: string | null
  setTeamApiKey: (key: string | null, workspacePath?: string) => Promise<void>
  reAuthTeamProvider: () => Promise<void>
```

In the store initial state, remove:
```typescript
  teamApiKey: getPersistedTeamApiKey(),
```

Remove the `getDeviceNodeId` function and `defaultTeamLiteLlmApiKey` function entirely:
```typescript
async function getDeviceNodeId(): Promise<string> { ... }
function defaultTeamLiteLlmApiKey(nodeId: string): string { ... }
```

Remove the `setTeamApiKey` action and `reAuthTeamProvider` action from the store.

- [ ] **Step 3: Simplify `applyTeamModelToOpenCode`**

Replace the section that determines the API key and calls `connectProvider`:

```typescript
      // Determine API key: user override or FC default virtual key (not raw nodeId)
      const nodeId = await getDeviceNodeId()
      const apiKey = teamApiKey || defaultTeamLiteLlmApiKey(nodeId)
      if (!apiKey) {
        console.error('[TeamMode] No API key and no device NodeId available')
        return
      }
      ...
      // Connect provider with key
      await providerStore.connectProvider(TEAM_PROVIDER_ID, apiKey)
```

With nothing — `connectProvider` is no longer called. Also, in `addCustomProviderToConfig`, pass the `${tc_api_key}` placeholder:

```typescript
      await addCustomProviderToConfig(workspacePath, {
        name: 'Team',
        baseURL: teamModelConfig.baseUrl,
        apiKey: '${tc_api_key}',
        models: [modelConfig],
      })
```

Remove the entire "wait for provider to register before selecting model" block that calls `client.getProviders()` in a loop checking for `TEAM_PROVIDER_ID` — this was needed because `connectProvider` was async and opencode needed time to register. Now the provider config is written before startup, so opencode already knows about it.

- [ ] **Step 4: Remove `_appliedConfigKey` logic that included `teamApiKey`**

The `configKey` fingerprint in `applyTeamModelToOpenCode` was:
```typescript
const configKey = `${teamModelConfig.baseUrl}|${teamModelConfig.model}|${teamApiKey || ''}`
```
Remove the `|${teamApiKey || ''}` part:
```typescript
const configKey = `${teamModelConfig.baseUrl}|${teamModelConfig.model}`
```

- [ ] **Step 5: Build TypeScript**

```bash
cd /Volumes/openbeta/workspace/teamclaw/packages/app && npx tsc --noEmit 2>&1 | head -30
```
Expected: no errors. Fix any remaining references to `teamApiKey`, `setTeamApiKey`, `reAuthTeamProvider`, or `getPersistedTeamApiKey`.

- [ ] **Step 6: Commit**

```bash
cd /Volumes/openbeta/workspace/teamclaw
git add packages/app/src/stores/team-mode.ts
git commit -m "feat(team-mode): remove localStorage auth, use \${tc_api_key} env var for team provider"
```

---

### Task 7: Simplify ChatPanel.tsx init logic

**Files:**
- Modify: `packages/app/src/components/chat/ChatPanel.tsx`

- [ ] **Step 1: Remove `reAuthTeamProvider` and `teamApiKey` from init effect**

Find the effect at line ~214. Currently:

```typescript
    const { loadTeamConfig, applyTeamModelToOpenCode, reAuthTeamProvider } = useTeamModeStore.getState();
    loadTeamConfig(workspacePath).then(async () => {
      if (useTeamModeStore.getState().teamMode) {
        const { _appliedConfigKey, teamModelConfig, teamApiKey } = useTeamModeStore.getState();
        const configKey = teamModelConfig
          ? `${teamModelConfig.baseUrl}|${teamModelConfig.model}|${teamApiKey || ''}`
          : null;
        if (configKey && configKey === _appliedConfigKey) {
          await reAuthTeamProvider();
        } else {
          await applyTeamModelToOpenCode(workspacePath);
        }
      }
      initProviderStore();
    });
```

Replace with:

```typescript
    const { loadTeamConfig, applyTeamModelToOpenCode } = useTeamModeStore.getState();
    loadTeamConfig(workspacePath).then(async () => {
      if (useTeamModeStore.getState().teamMode) {
        const { _appliedConfigKey, teamModelConfig } = useTeamModeStore.getState();
        const configKey = teamModelConfig
          ? `${teamModelConfig.baseUrl}|${teamModelConfig.model}`
          : null;
        if (configKey !== _appliedConfigKey) {
          await applyTeamModelToOpenCode(workspacePath);
        }
      }
      initProviderStore();
    });
```

When `configKey === _appliedConfigKey` (sidecar restarted externally), we no longer need to re-auth — the env var is already in the sidecar process environment.

- [ ] **Step 2: Build TypeScript**

```bash
cd /Volumes/openbeta/workspace/teamclaw/packages/app && npx tsc --noEmit 2>&1 | head -30
```
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
cd /Volumes/openbeta/workspace/teamclaw
git add packages/app/src/components/chat/ChatPanel.tsx
git commit -m "fix(chat): remove reAuthTeamProvider, simplify team mode init after sidebar refresh"
```

---

### Task 8: TypeScript types + EnvVarsSection UI

**Files:**
- Modify: `packages/app/src/stores/env-vars.ts`
- Modify: `packages/app/src/components/settings/EnvVarsSection.tsx`

- [ ] **Step 1: Add `category` to `EnvVarEntry` in the store**

In `packages/app/src/stores/env-vars.ts`, replace:

```typescript
export interface EnvVarEntry {
  key: string
  description?: string
}
```

With:

```typescript
export interface EnvVarEntry {
  key: string
  description?: string
  category?: 'system' | null
}
```

- [ ] **Step 2: Update `UnifiedEntry` in EnvVarsSection to carry `category`**

In `EnvVarsSection.tsx`, replace the `UnifiedEntry` type:

```typescript
type UnifiedEntry =
  | { scope: 'personal'; key: string; description?: string; category?: 'system' | null; dirty?: boolean }
  | { scope: 'team'; key: string; description: string; category: string; createdBy: string; updatedBy: string; updatedAt: string; dirty?: boolean }
```

Update the `personal` array in `unifiedEntries` useMemo to carry `category`:

```typescript
    const personal: UnifiedEntry[] = envVars.map((e) => ({
      scope: 'personal' as const,
      key: e.key,
      description: e.description,
      category: e.category,
      dirty: dirtyKeys.has(e.key),
    }))
```

- [ ] **Step 3: Add `Lock` to lucide-react imports and update `EnvVarRow`**

Add `Lock` to the import from `lucide-react` at the top of `EnvVarsSection.tsx`:

```typescript
import { KeyRound, Plus, Eye, EyeOff, Pencil, Trash2, ShieldCheck, AlertCircle, RefreshCw, Loader2, Users, User, Lock } from 'lucide-react'
```

In `EnvVarRow`, update the badge rendering section. Currently `isPersonal ? <Personal badge> : <Team badge>`. Add a system check before:

```typescript
  const isSystem = entry.scope === 'personal' && (entry as any).category === 'system'
  const isPersonal = entry.scope === 'personal'
```

Replace the badge JSX block:

```typescript
          {isSystem ? (
            <span className="inline-flex items-center gap-1 text-xs text-violet-600 dark:text-violet-400 bg-violet-50 dark:bg-violet-950/40 px-1.5 py-0.5 rounded">
              <Lock className="h-3 w-3" />
              {t('settings.envVars.scopeSystem', 'System')}
            </span>
          ) : isPersonal ? (
            <span className="inline-flex items-center gap-1 text-xs text-muted-foreground bg-muted px-1.5 py-0.5 rounded">
              <User className="h-3 w-3" />
              {t('settings.envVars.scopePersonal', 'Personal')}
            </span>
          ) : (
            <span className="inline-flex items-center gap-1 text-xs text-blue-600 dark:text-blue-400 bg-blue-50 dark:bg-blue-950/40 px-1.5 py-0.5 rounded">
              <Users className="h-3 w-3" />
              {t('settings.envVars.scopeTeam', 'Team')}
            </span>
          )}
```

- [ ] **Step 4: Hide delete for system entries**

In `canDeleteEntry`:

```typescript
  const canDeleteEntry = (entry: UnifiedEntry): boolean => {
    if (entry.scope === 'personal' && (entry as any).category === 'system') return false
    if (entry.scope === 'personal') return true
    if (myRole === 'owner') return true
    if (entry.scope === 'team' && entry.createdBy === currentNodeId) return true
    return false
  }
```

- [ ] **Step 5: Sort system entries first**

In the `unifiedEntries` useMemo, after building `personal` and `team` arrays, sort before returning:

```typescript
    const all = [...team, ...personal]
    // System entries first, then alphabetical within each group
    all.sort((a, b) => {
      const aIsSystem = a.scope === 'personal' && (a as any).category === 'system'
      const bIsSystem = b.scope === 'personal' && (b as any).category === 'system'
      if (aIsSystem && !bIsSystem) return -1
      if (!aIsSystem && bIsSystem) return 1
      return a.key.localeCompare(b.key)
    })
    return all
```

- [ ] **Step 6: Build TypeScript**

```bash
cd /Volumes/openbeta/workspace/teamclaw/packages/app && npx tsc --noEmit 2>&1 | head -30
```
Expected: no errors.

- [ ] **Step 7: Commit**

```bash
cd /Volumes/openbeta/workspace/teamclaw
git add packages/app/src/stores/env-vars.ts packages/app/src/components/settings/EnvVarsSection.tsx
git commit -m "feat(ui): show system env vars with lock badge, hide delete button"
```

---

### Task 9: Full build verification

- [ ] **Step 1: Rust build**

```bash
cd /Volumes/openbeta/workspace/teamclaw && cargo build -p teamclaw 2>&1 | tail -20
```
Expected: compiles clean.

- [ ] **Step 2: TypeScript build**

```bash
cd /Volumes/openbeta/workspace/teamclaw/packages/app && npx tsc --noEmit 2>&1 | head -30
```
Expected: no errors.

- [ ] **Step 3: Check no remaining references to removed symbols**

```bash
cd /Volumes/openbeta/workspace/teamclaw && grep -r "reAuthTeamProvider\|teamApiKey\|TEAM_API_KEY_STORAGE\|getPersistedTeamApiKey\|setTeamApiKey" packages/app/src --include="*.ts" --include="*.tsx" -l
```
Expected: no files listed (all references removed).

```bash
grep -r "keyring_service\b" src-tauri/src --include="*.rs"
```
Expected: only appears inside `env_vars.rs` if at all — no callers outside that file using the old per-key service function (it was renamed/replaced).

- [ ] **Step 4: Final commit**

```bash
cd /Volumes/openbeta/workspace/teamclaw
git commit --allow-empty -m "chore: system env vars feature complete"
```

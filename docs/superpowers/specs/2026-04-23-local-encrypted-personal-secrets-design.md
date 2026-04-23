# Local Encrypted Personal Secrets Storage — Design

**Date:** 2026-04-23  
**Status:** Draft approved in chat, written for review

## Goal

Remove runtime dependence on macOS Keychain / Windows Credential Manager / Linux Secret Service for personal secrets, while preserving:

- existing user-facing behavior for personal env vars and custom provider API keys
- existing team-shared secret sync behavior
- one-time migration from the legacy keyring-backed blob without deleting old keychain data immediately

The primary product goal is to eliminate repeated keychain permission prompts during app startup, OpenCode startup, and settings interactions.

## Scope

In scope:

- personal env-var storage currently implemented in `src-tauri/src/commands/env_vars.rs`
- OpenCode startup secret loading currently implemented in `src-tauri/src/commands/opencode.rs`
- custom provider API key persistence that currently calls `env_var_set`
- one-time migration from legacy keychain-backed personal secrets

Out of scope:

- `shared_secrets` team sync and encryption flow
- `system-shared` env vars whose values live in team shared secrets
- team secret, member, or sync protocols
- cross-device recovery or export/import for personal secrets
- deleting legacy keychain entries in the first release of this change

## Recommended Approach

Use a single locally stored master key plus a single encrypted blob file for all personal secrets.

This replaces the current keyring blob with:

- `~/.teamclaw/secrets/master.key`
- `~/.teamclaw/secrets/personal-secrets.json.enc`
- `~/.teamclaw/secrets/meta.json`

The master key is randomly generated, stored locally with user-only file permissions, and used to encrypt/decrypt the personal secrets blob. Team shared secrets remain on their current storage and sync path.

This design is preferred over per-secret files or per-workspace secret stores because the current system already models personal secrets as a single blob, and the single-blob approach minimizes file I/O, startup work, and future prompt-like failure modes.

## Storage Layout

### `master.key`

- 32 random bytes generated once on first initialization or migration
- stored as raw bytes or a simple base64-encoded file
- file permissions restricted to the current user
- never synced through team files

### `personal-secrets.json.enc`

- encrypted representation of the full personal secret map
- plaintext structure remains a JSON object of key to string value
- written atomically via temp file + rename

Example plaintext after decryption:

```json
{
  "OPENAI_API_KEY": "sk-...",
  "anthropic_api_key": "sk-ant-...",
  "tc_api_key": "sk-tc-..."
}
```

### `meta.json`

Contains only non-sensitive metadata, for example:

```json
{
  "version": 1,
  "algorithm": "aes-256-gcm",
  "migrated_from_keychain": true
}
```

`meta.json` must not contain plaintext secrets or key material.

## Encryption Design

Use a standard AEAD construction with a fresh random nonce on each write. `AES-256-GCM` is the default recommendation because it is common, well-understood, and straightforward in the current Rust stack.

Write path:

1. Load `master.key`
2. Serialize the full secret map to JSON
3. Generate a fresh random nonce
4. Encrypt using AEAD
5. Persist the encrypted payload atomically

Read path:

1. Load `master.key`
2. Read encrypted blob from disk
3. Decrypt and authenticate
4. Parse JSON into the existing map shape

Integrity failure must be treated as a hard read failure. The app must not silently replace a blob that fails authentication.

## Runtime Behavior

### Personal env vars

The public Tauri commands remain behaviorally the same:

- `env_var_set`
- `env_var_get`
- `env_var_delete`
- `env_var_list`
- `env_var_resolve`

The implementation changes underneath them:

- metadata index still lives in `teamclaw.json`
- secret values no longer touch the OS keyring
- reads and writes use the local encrypted blob instead

### OpenCode startup

OpenCode startup currently performs repeated keyring reads through `ensure_system_env_vars` and `read_keyring_secrets`. After this change:

- startup reads the local encrypted blob once
- system env vars are seeded or regenerated against the local decrypted blob
- OpenCode placeholder resolution uses the decrypted local secrets

This preserves current placeholder behavior while removing keychain access from the startup path.

### Team shared secrets

No behavioral change:

- `shared_secrets` remains the source of truth for team-shared values
- `system-shared` entries remain indexed in the UI as they are today
- local encrypted storage is only for personal secrets

## Migration Strategy

Migration must be one-time, conservative, and non-destructive.

Startup order:

1. Try to read the new local encrypted storage
2. If it exists and decrypts successfully, use it and never touch keychain
3. If it does not exist, try reading the legacy keychain blob
4. If legacy data exists, generate `master.key`, write the encrypted blob, and write `meta.json`
5. If neither exists, initialize an empty encrypted store

Migration rules:

- migration copies personal secrets from legacy keychain storage into the new encrypted store
- migration does not delete old keychain data in the first release
- migration sets `migrated_from_keychain: true` in metadata
- all subsequent reads and writes use the new local encrypted store

## Failure Handling

### New encrypted store exists but cannot decrypt

- return an explicit error
- do not overwrite the encrypted blob
- do not silently fall back and merge with legacy data

This avoids turning corruption or key mismatch into silent data loss.

### Migration read succeeds but encrypted write fails

- surface the error
- keep legacy keychain data untouched
- do not mark migration complete

### `master.key` missing while encrypted blob exists

- treat the local store as unrecoverable
- report that personal secrets need reconfiguration
- do not affect team shared secrets

### No secrets anywhere

- initialize an empty store
- preserve current UX for adding new personal secrets later

## Security Properties

This design intentionally trades some OS-managed secret-storage guarantees for zero keychain dependence.

Properties kept:

- secrets are not stored in plaintext config files
- disk theft without the local files is not enough
- blob tampering is detectable through authenticated decryption

Properties weakened relative to OS keychain:

- the master key is stored locally rather than inside an OS-protected credential store
- compromise of the user account with file access can expose the master key and encrypted blob together
- reinstall/migration recovery is not automatic unless later product work adds export/import

This tradeoff is accepted for this feature because the explicit user requirement is complete removal of keychain dependence.

## Implementation Areas

### New backend module

Add a new secrets-storage module in `src-tauri/src/commands/` that owns:

- filesystem path derivation
- master-key initialization/loading
- encrypted blob read/write
- one-time migration from legacy keyring blob

`env_vars.rs` should stop owning storage mechanics directly and instead call this module.

### `env_vars.rs`

Refactor to:

- keep `teamclaw.json` metadata responsibilities
- delegate secret value storage to the new local encrypted storage module
- remove keyring-specific code from the steady-state path

### `opencode.rs`

Refactor startup helpers to:

- read personal secrets from the new local encrypted storage
- preserve existing merge order with shared secrets and process env vars
- stop performing keychain retries for the normal path

### Provider flows

No product-level behavior change is needed. Any path currently calling `env_var_set` for provider keys continues to work once the storage backend changes.

## Verification

Required verification coverage:

- new install with no prior secrets
- upgrade from legacy keychain-backed secrets
- `env_var_set/get/delete/list/resolve` behavior unchanged at the API level
- OpenCode startup resolves `${KEY}` references from local encrypted storage
- team shared secrets still resolve ahead of personal secrets where applicable
- corrupted encrypted blob produces a safe, explicit error
- missing `master.key` with present blob produces a safe failure

Recommended tests:

- unit tests for encrypt/decrypt round-trip and tamper detection
- migration tests from a mocked legacy blob source
- command-level tests for env-var CRUD using the new storage backend
- integration coverage for OpenCode placeholder resolution

## Rollout

Release 1:

- introduce local encrypted personal secret storage
- migrate from legacy keychain on demand
- keep legacy keychain data untouched after migration

Future release:

- optionally add explicit cleanup of legacy keychain entries
- optionally add export/import or recovery workflow for personal secrets

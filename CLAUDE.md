# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

For **UI / visual design** work, source-of-truth depends on the platform:

- **iOS** (`apps/ios/`): `apps/ios/DESIGN.md` — the Hai 灰 palette, wabi-sabi
  language, and SwiftUI implementation conventions (tokens, Hai sheets, iOS 26
  toolbar rules). Read this before touching anything in `apps/ios/`.
- **Web / desktop** (`packages/app/`): `AGENTS.md` at the repo root — the
  Editorial Calm direction (paper neutrals, coral accent, Chinese-first type).

## Git Workflow

**Never push directly to `main`.** All changes go through a feature branch and a
Pull Request:

1. Work on a task-scoped branch, never on `main`.
2. **Wait for the user to explicitly ask you to open the PR.** Do not `git push`
   or run `gh pr create` on your own initiative, even if the work looks "done"
   and tests pass. An explicit "open the PR", "ship it", "提 PR", or
   "可以提 PR 了" is the trigger; absent that, stop after committing and report
   back.
3. Do not merge or push to `main` directly, even for small fixes.

If `docs/SDLC.md` exists in this checkout, read it before starting any change.
It is a local, git-ignored SDLC override that can layer additional personal
workflow (e.g. worktree + preview-integration conventions) on top of the rules
above. It is intentionally not checked in, so it only affects the workspace that
has it.

## Project Overview

TeamClaw is an AI Agent Desktop Platform built with Tauri 2.0 + React 19. Three-column layout chat/collaboration tool with local AI agents, team sync (Git / OSS, owned by the amuxd daemon), and multi-channel gateways.

## Commands

```bash
# Install
pnpm install

# Dev
pnpm dev                    # Frontend only (Vite)
pnpm tauri:dev              # Full Tauri desktop app
pnpm tauri:dev -- --skip-setup --skip-daemon-onboarding  # Dev: skip first-run wizards
pnpm rust:check             # Fast Rust compile check with shared .cargo-target
pnpm rust:build             # Rust build with shared .cargo-target
pnpm daemon:run             # Run amuxd from apps/daemon
pnpm ios:run                # Build, install, and launch iOS app on booted Simulator

# Build
pnpm tauri:build            # Production build
pnpm tauri:build:debug      # Debug build
pnpm tauri:build:mac:all    # macOS dual-arch (ARM64 + Intel)
pnpm daemon:build           # Build daemon
pnpm ios:build              # Build iOS simulator app

# Lint & Typecheck
pnpm lint                   # ESLint (frontend)
pnpm typecheck              # TypeScript strict
cargo fmt --check --manifest-path apps/desktop/Cargo.toml
cargo clippy --manifest-path apps/desktop/Cargo.toml -- -D warnings

# Test
pnpm test:unit              # Vitest unit tests
pnpm test:e2e               # E2E (requires built app + tauri-mcp)
pnpm test:smoke             # Smoke subset
pnpm daemon:test            # Daemon tests
pnpm ios:test:core          # AMUXCore SwiftPM tests
pnpm ios:test               # iOS UI tests

# FC deploy — no GitHub Actions deployment is configured.
```

## Architecture

**Monorepo layout:**
- `packages/app/` — React 19 frontend (TypeScript, Tailwind 4, Zustand, Vite)
- `apps/desktop/` — Rust/Tauri backend (commands, RAG via Tantivy, STT via Whisper)
- `apps/daemon/` — amuxd daemon (ACP runtime, MQTT/Supabase bridge)
- `apps/ios/` — iOS app, Xcode project, and Swift packages
- `services/supabase/` — Supabase migrations, seed, and database tests
- `services/fc/` — Alibaba Cloud Function Compute (Node.js 20, serverless team API)
- `crates/` — shared Rust crates (`teamclaw-proto`, `teamclaw-types`, `teamclaw-transport`)
- `tests/` — E2E tests (tauri-mcp): smoke, regression, performance, functional

**Frontend key paths:**
- `packages/app/src/stores/` — Zustand stores (50+ files, global state)
- `packages/app/src/components/` — React components (editors, chat, diff)
- `packages/app/src/lib/` — Utilities (RAG, git, skills)
- `packages/app/src/hooks/` — React hooks

**Rust backend key paths:**
- `apps/desktop/src/commands/` — Tauri IPC commands (oss_sync/, team_share/, team_git.rs, gateway/, cron/, etc.)
- `apps/desktop/crates/teamclaw-rag/` — Full-text search (Tantivy) + embeddings
- `apps/desktop/crates/teamclaw-stt/` — Speech-to-text (Whisper)
- `apps/desktop/binaries/` — sidecar binaries (teamclaw-introspect, etc.)

**Editor system:** Markdown (Tiptap) / HTML (Tiptap + sandbox preview) / Code (CodeMirror 6 + Shiki)

## Backend Access Boundary — Cloud API is the only client backend

**`cloud_api` is the only backend kind for clients. The `supabase` and `pocketbase` backend kinds have been removed from `packages/app/`. Direct `@supabase/supabase-js` usage in client code is forbidden and enforced by a guardrail test (`packages/app/src/lib/backend/__tests__/no-supabase-import.test.ts`).**

The API contract is defined in `docs/openapi/teamclaw-api.v1.yaml`. All business data operations must go through the TeamClaw Cloud API (`/v1`) rather than direct Supabase client calls.

The Cloud API facade (`services/fc/lib/business-api.mjs`) is the canonical entry point for teams, sessions, messages, and invite operations. Clients (Tauri, Expo, iOS, daemon) should use their respective Cloud API providers:

- **Web/Desktop** (`packages/app/`): `CloudApiProvider` in `packages/app/src/lib/backend/provider.ts`
- **Expo** (`apps/expo/`): `createCloudSessionsApi` in `apps/expo/src/features/sessions/cloud-api.ts`
- **iOS** (`apps/ios/`): `CloudAPIClient` / `CloudAPIRepositories` in `apps/ios/Packages/AMUXCore/Sources/AMUXCore/CloudAPI/`
- **daemon** (`apps/daemon/`): `cloud_api` backend module in `apps/daemon/src/backend/cloud_api.rs`

Direct Supabase client usage (e.g. `supabase.from('sessions').select()`) is **reserved for internal FC repository implementation only** (`services/fc/lib/supabase-repo.mjs`). The FC facade forwards caller bearer tokens to Supabase, preserving RLS and auth semantics.

**When adding new business endpoints:**

1. Define the endpoint in `docs/openapi/teamclaw-api.v1.yaml` first.
2. Implement the repository contract in `services/fc/lib/repository-contract.mjs`.
3. Add the route handler in `services/fc/lib/business-api.mjs`.
4. Implement the Supabase passthrough in `services/fc/lib/supabase-repo.mjs`.
5. Add tests in `services/fc/test/` (route, repository, contract).
6. Wire the endpoint into client Cloud API providers.

Do not bypass the Cloud API and call Supabase directly from client code. The facade exists so future backend replacements (MySQL, other storage) happen inside FC without client rewrites.

## Streaming Architecture (Critical)

Single source of truth principle — **never mix content sources**:
- **Streaming phase**: display from `streamingContent` (built from delta buffer)
- **Completed phase**: display from `message.content` (built from `message.parts[]`)
- **Never** write to `msg.content` during streaming
- **Never** use "longest content" strategy on completion

## Team Collaboration

Team sync is owned by the amuxd daemon (git + OSS engine). The legacy
iroh-based P2P mode has been removed.

A team picks one **share mode** during onboarding; it is then locked
server-side (`ShareMode` in `packages/app/src/stores/team-share.ts`, mirroring
`GET /v1/teams/:id/share-mode`):

- **`oss`**: Alibaba OSS with WebDAV
- **`managed_git`**: Git repo provisioned via `/managed-git/create-repo`
- **`custom_git`**: self-hosted Git repo

Shared: `skills/`, `.mcp/`, `knowledge/`

## Versioning & Release

**Version numbers** — Desktop version must match across `package.json`, `apps/desktop/Cargo.toml`, `apps/desktop/tauri.conf.json`, and `apps/daemon/Cargo.toml` (bundled `amuxd` sidecar).

**Release process:**
1. Bump desktop version in all 4 files
2. Commit, push to main
3. `git tag v<desktop-version> && git push origin v<desktop-version>`
4. Tag push triggers `release.yml` (macOS desktop)

## iOS TestFlight Release

**Version file:** `apps/ios/project.yml` — `MARKETING_VERSION` (e.g. `1.1.5`) + `CURRENT_PROJECT_VERSION` (build number, increment by 1 each release).

**Release process:**
1. Bump `CURRENT_PROJECT_VERSION` in `apps/ios/project.yml`
2. Commit and push to main
3. `git tag ios-v<version>-<build> && git push origin ios-v<version>-<build>`
   - Example: `git tag ios-v1.1.5-4 && git push origin ios-v1.1.5-4`
4. Tag push triggers `.github/workflows/testflight.yml` (runs `fastlane beta` on CI)

**Tag format must be `ios-v*`** — other formats (e.g. `ios-1.1.5-4`) do not trigger the workflow.

## FC (Function Compute) Deployment

FC function `teamclaw-sync` is deployed to Alibaba Cloud cn-shenzhen region.

Deploy: no GitHub Actions deployment is configured for FC. Do not assume that
merging `services/fc/**` changes to `main` updates Alibaba Cloud automatically.
Coordinate the current production deployment path before changing FC runtime
configuration.

Production endpoint: `https://cloud.ucar.cc`

FC endpoints: `/register`, `/token`, `/reset-secret`, `/apply`, `/ai/setup-team`, `/ai/add-member`, `/ai/remove-member`, `/ai/keys`, `/ai/usage`, `/ai/budget`, `/managed-git/create-repo`

Team share onboarding endpoints (see `docs/openapi/teamclaw-api.v1.yaml`):

- `POST /v1/teams/:id/share-mode` — one-shot lock to `oss` | `managed_git` | `custom_git` (409 once locked).
- `GET  /v1/teams/:id/share-mode` — `{ mode, enabledAt, gitRemoteUrl, gitAuthKind }`; `mode: null` means team-share 未开通.
- `GET  /v1/teams/:id/workspace-config` — merged shape `{ shareMode, gitRemoteUrl, gitAuthKind, syncMode, litellmTeamId }`. The legacy `{ defaultWorkspaceId, pinnedWorkspaceIds }` shape now lives at `GET /v1/teams/:id/workspace-defaults` (PUT path is unchanged).
- `POST /v1/teams/:id/litellm/setup` — provisions LiteLLM and returns `{ aiGatewayEndpoint, litellmKey }`; 503 `litellm_unavailable` if FC is not configured.

<!-- seahelm:suggest:start -->
## Quick options for the user (seahelm)

When you finish a turn and can anticipate the user's likely next steps, run:

    seahelm-suggest 'first option' 'second option'

Each option is a short imperative phrase (max ~5 options). Do NOT print options
as text in your reply — the user sees them as clickable buttons in seahelm.
<!-- seahelm:suggest:end -->

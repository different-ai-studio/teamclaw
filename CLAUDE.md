# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

TeamClaw is an AI Agent Desktop Platform built with Tauri 2.0 + React 19. Three-column layout chat/collaboration tool with local AI agents, team P2P/OSS sync, and multi-channel gateways.

## Commands

```bash
# Install
pnpm install

# Dev
pnpm dev                    # Frontend only (Vite)
pnpm tauri:dev              # Full Tauri desktop app
pnpm rust:check             # Fast Rust compile check with shared .cargo-target
pnpm rust:build             # Rust build with shared .cargo-target

# Build
pnpm tauri:build            # Production build
pnpm tauri:build:debug      # Debug build
pnpm tauri:build:mac:all    # macOS dual-arch (ARM64 + Intel)

# Lint & Typecheck
pnpm lint                   # ESLint (frontend)
pnpm typecheck              # TypeScript strict
cargo fmt --check --manifest-path src-tauri/Cargo.toml
cargo clippy --manifest-path src-tauri/Cargo.toml -- -D warnings

# Test
pnpm test:unit              # Vitest unit tests
pnpm test:e2e               # E2E (requires built app + tauri-mcp)
pnpm test:e2e:smoke         # Smoke subset

# FC deploy
bash .claude/skills/fc-deploy/deploy.sh
```

## Architecture

**Monorepo layout:**
- `packages/app/` — React 19 frontend (TypeScript, Tailwind 4, Zustand, Vite)
- `src-tauri/` — Rust/Tauri backend (commands, RAG via Tantivy, STT via Whisper, P2P via iroh)
- `fc/` — Alibaba Cloud Function Compute (Node.js 20, serverless team API)
- `tests/` — E2E tests (tauri-mcp): smoke, regression, performance, functional

**Frontend key paths:**
- `packages/app/src/stores/` — Zustand stores (50+ files, global state)
- `packages/app/src/components/` — React components (editors, chat, diff)
- `packages/app/src/lib/` — Utilities (RAG, git, skills)
- `packages/app/src/hooks/` — React hooks

**Rust backend key paths:**
- `src-tauri/src/commands/` — Tauri IPC commands (34 modules: opencode, oss_sync, team_p2p, gateway/, cron/)
- `src-tauri/src/rag/` — Full-text search + embeddings
- `src-tauri/binaries/` — OpenCode sidecar

**Editor system:** Markdown (Tiptap) / HTML (Tiptap + sandbox preview) / Code (CodeMirror 6 + Shiki)

## Streaming Architecture (Critical)

See `packages/app/src/stores/STREAMING_ARCHITECTURE.md` for full details.

Single source of truth principle — **never mix content sources**:
- **Streaming phase**: display from `streamingContent` (built from delta buffer)
- **Completed phase**: display from `message.content` (built from `message.parts[]`)
- **Never** write to `msg.content` during streaming
- **Never** use "longest content" strategy on completion

## Team Collaboration

- **P2P mode**: iroh-based (Linux/macOS only)
- **S3/OSS mode**: Alibaba OSS with WebDAV
- Shared: `skills/`, `.mcp/`, `knowledge/`

## FC (Function Compute) Deployment

FC function `teamclaw-sync` is deployed to Alibaba Cloud cn-shenzhen region.

Deploy: use the `fc-deploy` skill (`.claude/skills/fc-deploy/deploy.sh`).

Production endpoint: `https://cloud.ucar.cc`

FC endpoints: `/register`, `/token`, `/reset-secret`, `/apply`, `/ai/setup-team`, `/ai/add-member`, `/ai/remove-member`, `/ai/keys`, `/ai/usage`, `/ai/budget`

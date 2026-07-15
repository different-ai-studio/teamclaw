# TeamClaw

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![CI](https://github.com/different-ai-studio/teamclaw/actions/workflows/ci.yml/badge.svg)](https://github.com/different-ai-studio/teamclaw/actions)
[![Contributors](https://img.shields.io/github/contributors/different-ai-studio/teamclaw.svg)](https://github.com/different-ai-studio/teamclaw/graphs/contributors)

Local AI agents — your AI Ally for every role

> **Your Ally. Together.**

- **👥 Built for teams** — share Skills, Knowledge, and MCP config across the whole team via Git or S3/OSS sync; each member keeps their own private context
- **🎭 Skills × Roles** — a composable role library lets the same agent specialize for sales, support, ops, engineering, or whatever your team needs
- **🔋 Batteries included** — built-in RAG knowledge base, Auto UI understanding, speech-to-text, and six channel gateways (WeCom, Feishu, Discord, Kook, WeChat, Email) — no glue code
- **🧑‍💻 Solo builders to SMBs** — local-first, private by default; scales from a single user to a small company

English | [简体中文](README.zh-CN.md) | [繁體中文](README.zh-TW.md) | [日本語](README.ja.md) | [한국어](README.ko.md)

## Screenshots

| Home | Channels |
|---|---|
| ![TeamClaw Home](images/home.png) | ![TeamClaw Channels](images/channel.png) |

## Features

- **Three-column workspace** — sidebar, chat, and detail panel
- **Local agent runtime** — agents run on your machine, hosted by the `amuxd` daemon over the ACP protocol
- **Channel gateways** — reach your agents from Discord, Feishu, Email, Kook, WeCom, and WeChat
- **Automation** — scheduled tasks via cron
- **Team collaboration** — share a workspace over OSS or Git; see [Team collaboration](#team-collaboration)
- **MCP support** — connect agents to enterprise systems via the Model Context Protocol
- **Skills / plugins** — extend agents with workspace-level and global skill sources
- **Knowledge base** — full-text and embedding-based indexing and search
- **Built-in editors** — Markdown and HTML (Tiptap), code (CodeMirror 6), and an agent-first diff reviewer
- **Local file operations** — with per-operation permission management

## How it works

TeamClaw is split into a client layer, an agent host, and a cloud backend:

```
  Desktop (Tauri)     iOS      Mobile (Expo)     Chrome extension
        │              │            │                  │
        └──────────────┴─────┬──────┴──────────────────┘
                             │
              ┌──────────────┴───────────────┐
              │      TeamClaw Cloud API      │   identity, teams,
              │            (/v1)             │   sessions, messages
              └──────────────┬───────────────┘
                             │
                    ┌────────┴────────┐
                    │   amux daemon   │  agent host + channel gateways
                    │    (amuxd)      │  + team sync (git / OSS)
                    └────┬───────┬────┘
                         │ ACP   │ ACP
                    ┌────┴──┐ ┌──┴────┐
                    │opencode│ │ codex │  …
                    └────────┘ └───────┘
```

- **Clients** own the UI and local files. Installing TeamClaw Desktop also installs the `amuxd` daemon, so your machine is an agent host out of the box.
- **amuxd** hosts agent processes over ACP, runs the channel gateways, and owns team sync. It can also be installed standalone on a server, with no GUI.
- **Cloud API** (`/v1`) is the only backend clients talk to. See [`docs/openapi/teamclaw-api.v1.yaml`](docs/openapi/teamclaw-api.v1.yaml) for the contract, and [`docs/architecture/v2.md`](docs/architecture/v2.md) for the full architecture.

## Clients

| Client | Path | Status |
|---|---|---|
| **Desktop** (macOS / Windows / Linux) | `apps/desktop/` + `packages/app/` | Primary client |
| **iOS** | `apps/ios/` | Native SwiftUI, ships via TestFlight |
| **Mobile** (iOS / Android) | `apps/expo/` | Expo; onboarding and sessions |
| **Chrome extension** | `apps/extension/` | MV3 |

## Install

Download the installer for your platform from [GitHub Releases](https://github.com/different-ai-studio/teamclaw/releases) — `.dmg` for macOS, `.exe` for Windows.

### macOS "damaged" warning

If macOS reports the app is **"damaged"** or **"cannot be opened because the developer cannot be verified"**, that's Gatekeeper reacting to an unsigned download. Clear the quarantine attribute:

```bash
xattr -cr /Applications/TeamClaw.app
```

This step isn't needed for builds signed and notarized with an Apple Developer certificate.

## Quick start (development)

**Prerequisites:** Node.js >= 20, pnpm >= 10, Rust >= 1.70

```bash
pnpm install
pnpm tauri:dev
```

After launching, pick a workspace directory in the TeamClaw UI.

To skip the first-run wizards during development:

```bash
pnpm tauri:dev -- --skip-setup --skip-daemon-onboarding
```

For the frontend alone (no Rust build), run `pnpm dev`. Build commands, the shared Rust build cache, the test suites, and the repo layout are covered in the [Contributing Guide](CONTRIBUTING.md).

## Team collaboration

A team shares its workspace through one of three **share modes**, chosen once during team onboarding and then locked server-side:

| Mode | What it does |
|---|---|
| `oss` | Syncs through S3-compatible object storage (Alibaba OSS / WebDAV) |
| `managed_git` | Syncs through a Git repository provisioned for you |
| `custom_git` | Syncs through a Git repository you host yourself |

Sync is owned by the `amuxd` daemon, which runs the Git and OSS engines.

### What gets shared

Only the shared layer syncs — a whitelist `.gitignore` keeps everything else local:

- `skills/` — shared agent skills
- `.mcp/` — MCP server configuration
- `knowledge/` — team knowledge base documents

Personal files and workspace configuration are never synced.

### Notes

- Git modes need working Git authentication (SSH key or HTTPS token).
- Shared files follow the remote; local edits to them are overwritten on sync.
- Sync runs on app startup, and can be triggered manually from **Settings → Team**.

## Configuration

Build-time configuration lives in `build.config.*.json` at the repo root, merged in this order:

```
build.config.json → build.config.${BUILD_ENV}.json → build.config.local.json
```

Copy the example to get started:

```bash
cp build.config.example.json build.config.local.json
```

The key setting is `cloudApiUrl`, which points the app at a TeamClaw Cloud API deployment:

```json
{
  "cloudApiUrl": "https://cloud.ucar.cc",
  "features": {
    "channels": { "discord": true, "feishu": true, "email": true }
  }
}
```

`build.config.local.json` is git-ignored. For local development you can also override the endpoint with `VITE_CLOUD_API_URL` in `packages/app/.env.local`. Rebuild for changes to take effect.

The Cloud API implementation lives in `services/fc/` (Node.js 20), backed by Supabase and, optionally, a LiteLLM proxy for shared AI budget management.

## Documentation

- [Architecture](docs/architecture/v2.md) — components, topology, and data model
- [API contract](docs/openapi/teamclaw-api.v1.yaml) — TeamClaw Cloud API `/v1`
- [Context map](CONTEXT-MAP.md) — how the repo is divided into bounded contexts
- [Contributing](CONTRIBUTING.md) — dev setup, testing, repo layout
- [Security policy](SECURITY.md)

## Contributing

We welcome contributions! See the [Contributing Guide](CONTRIBUTING.md) for details.

- 📝 [Documentation & translation](CONTRIBUTING.md#-documentation--translation-easiest) — no dev environment needed
- 🐛 [Bug reports](CONTRIBUTING.md#-bug-reports)
- ✨ [Feature suggestions](CONTRIBUTING.md#-feature-suggestions)
- 🔧 [Frontend development](CONTRIBUTING.md#-frontend-development)
- ⚙️ [Rust development](CONTRIBUTING.md#-rust-development)

## Tech stack

- **Desktop**: Tauri 2.0 (Rust)
- **Daemon**: Rust (`amuxd`), ACP over the Zed agent protocol
- **Frontend**: React 19 + TypeScript, Tailwind CSS 4, Zustand
- **iOS**: SwiftUI + SwiftPM (`AMUXCore`)
- **Editors**: Tiptap (Markdown / HTML), CodeMirror 6 (code), Shiki (highlighting)
- **Search**: Tantivy full-text + embeddings

## License

MIT
</content>

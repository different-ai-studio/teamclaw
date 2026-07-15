# TeamClaw v2 (worktree branch: `v2/amuxd-architecture`)

> **Architecture migration in progress.** This branch is the v2 rebuild described in
> `docs/superpowers/specs/2026-05-08-amuxd-architecture-design.md`. Plan:
> `docs/superpowers/plans/2026-05-08-amuxd-architecture-phase-0-1.md`.
>
> **Phase 1 status (2026-05-09): single-window scope.** Verified working end-to-end:
> Supabase email+password auth, session list from Supabase, message history load on
> session select, send → MQTT publish + Supabase persist + optimistic local append,
> `ActorMessageList` rendering. Multi-window round-trip
> is **descoped** — the broker on the configured EMQX host does not echo publishes
> back to the same client, and `create_workspace_window` shares a single MQTT client
> across webviews; cross-process round-trip is deferred to a future phase or broker
> config change.
>
> **Local dev requires** `packages/app/.env.development.local` (gitignored) with:
> - `VITE_SUPABASE_URL`
> - `VITE_SUPABASE_ANON_KEY`
> - `VITE_MQTT_HOST`, `VITE_MQTT_PORT`, `VITE_MQTT_USERNAME`, `VITE_MQTT_PASSWORD`
>
> Wire format: `proto/amux.proto` + `proto/teamclaw.proto`, vendored from
> `proto/`. Topics: `amux/{team}/session/{sid}/live`.
>
> **Known Phase 1 debt to clear in Phase 2:** the Phase 1E `useSessionStore`
> compat shim (`packages/app/src/stores/session-store.ts`) provides stub fields and
> no-op methods so 26 legacy consumer files (`AppSidebar`, parts of `ChatPanel`,
> `MessageList`, `SessionList`, etc.) compile and render against the lean v2
> store. Buttons like archive / rename / pin / permission flow `console.warn` and
> no-op. `noUnusedLocals`/`noUnusedParameters` in `packages/app/tsconfig.json` are
> temporarily disabled while those consumers carry intentionally-unused vars.
>
> Phase 2 (daemon installer + ACP runtime + agent streaming + permission flow) is
> the next plan and where the compat shim should be peeled off as those UI paths
> get rewired.
>
> **Backend provider direction:** v2 currently uses Supabase as the authority for
> auth, teams, actors, sessions, messages, invites, runtime cursors, and
> attachment metadata. The planned open-source evolution is to keep Supabase as
> one official backend provider, then introduce provider boundaries before adding
> alternatives such as local SQLite, TrailBase, PocketBase, or plain Postgres.
> See `docs/architecture/v2.md` §3.5.

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![CI](https://github.com/different-ai-studio/teamclaw/actions/workflows/ci.yml/badge.svg)](https://github.com/different-ai-studio/teamclaw/actions)
[![Contributors](https://img.shields.io/github/contributors/different-ai-studio/teamclaw.svg)](https://github.com/different-ai-studio/teamclaw/graphs/contributors)

Local AI agents — your AI Ally for every role

> **Your Ally. Together.**

- **👥 Built for teams** — share Skills, Knowledge, and Shortcuts across the whole team via Git or S3/OSS sync; each member keeps their own private context
- **🎭 Skills × Roles** — a composable role library lets the same agent specialize for sales, support, ops, engineering, or whatever your team needs
- **🔋 Batteries included** — built-in RAG knowledge base, Auto UI understanding, Browser control, and six channel gateways (WeCom, Feishu, Discord, Kook, WeChat, Email) — no glue code
- **🧑‍💻 Solo builders to SMBs** — local-first, private by default, zero-ops deployment; scales from a single user to a small company

English | [简体中文](README.zh-CN.md) | [繁體中文](README.zh-TW.md) | [日本語](README.ja.md) | [한국어](README.ko.md)

## UI Screenshots

### Home

![TeamClaw Home](images/home.png)

### Channels

![TeamClaw Channels](images/channel.png)

### Team

![TeamClaw Team](images/team.png)

## Features

- Three-column layout (Sidebar, Chat, Detail Panel)
- Local agent runtime for Agent capabilities
- Channel gateways: Discord, Feishu, Email, Kook, WeCom, WeChat
- Automation (Cron) for scheduled tasks
- Team collaboration modes: P2P and S3/OSS
- MCP (Model Context Protocol) support for enterprise systems
- Skills/Plugins extension system with workspace and global skill sources
- Knowledge base indexing/search and token usage/telemetry settings
- Local file operations with permission management

## Contributing

We welcome contributions! Please see our [Contributing Guide](CONTRIBUTING.md) for details.

- 📝 [Documentation & Translation](CONTRIBUTING.md) - No dev environment needed!
- 🐛 [Bug Reports](CONTRIBUTING.md#bug-reports)
- ✨ [Feature Suggestions](CONTRIBUTING.md#feature-suggestions)
- 🔧 [Frontend Development](CONTRIBUTING.md#frontend-development)
- ⚙️ [Rust Development](CONTRIBUTING.md#rust-development)

## Tech Stack

- **Desktop**: Tauri 2.0 (Rust)
- **Frontend**: React 19 + TypeScript
- **Styling**: Tailwind CSS 4
- **State**: Zustand
- **Editors**: Tiptap (Markdown/HTML), CodeMirror 6 (Code)
- **Diff**: Custom Diff Renderer with Shiki syntax highlighting

## Install

Download the installer for your platform from [GitHub Releases](https://github.com/different-ai-studio/teamclaw/releases) (`.dmg` for macOS, `.exe` for Windows).

- **Windows**: See [Windows Install Guide](docs/windows-install-guide.md).

### macOS "damaged" warning

If macOS shows **"damaged"** or **"cannot be opened because the developer cannot be verified"** after installing, this is caused by Gatekeeper. Run the following command in Terminal to remove the restriction:

```bash
xattr -cr /Applications/TeamClaw.app
```

This is not needed if the app is signed and notarized with an Apple Developer certificate.

## Development

### Prerequisites

- Node.js >= 20
- pnpm >= 10
- Rust >= 1.70

### Quick Start

```bash
# 1. Install dependencies
pnpm install

# 2. (Optional) Build local MCP sidecars — see apps/desktop/binaries/README.md

# 3. Start Tauri dev
pnpm tauri dev
```

After launching, select a workspace directory in the TeamClaw UI.

### Faster Rust Iteration

Rust and Tauri commands now reuse a shared `.cargo-target/` directory across worktrees and automatically enable `sccache` when it is installed.

```bash
# Fast Rust-only compile check
pnpm rust:check

# Full Rust build using the same shared cache
pnpm rust:build
```

Notes:
- `pnpm tauri:dev` and `pnpm tauri:build` use the same shared Rust build environment.
- `.cargo-target/` is local-only and ignored by git.
- Install `sccache` if you want compiler cache hits in addition to the shared target directory.

> **MCP binaries**: For local RAG MCP use the standalone `rag-mcp-server` build (not an in-app HTTP bridge). Optional sidecar build steps are in [apps/desktop/binaries/README.md](apps/desktop/binaries/README.md).

## Team Collaboration

TeamClaw supports multiple team collaboration modes:

- **P2P mode**: Local-network team collaboration with ticket-based join and member roles
- **S3/OSS mode**: Cloud-backed team sync

### Setting Up a Team Repository

1. Open **Settings** > **Team**
2. Enter the team Git repository URL (HTTPS or SSH)
3. Click "Connect"
4. TeamClaw will automatically:
   - Initialize a local Git repository
   - Pull remote repository contents
   - Generate a whitelist `.gitignore` (only syncs shared directories)

### Configuring the Team FC Endpoint

TeamClaw uses a serverless backend (FC — Function Compute) to handle team registration, authentication, and AI budget management. The FC endpoint is configured at **build time** via `build.config.*.json`.

**Configuration files:**

| File | Purpose |
|------|---------|
| `build.config.example.json` | Template — copy this to get started |
| `build.config.local.json` | Local development (git-ignored) |
| `build.config.production.json` | Production builds |

**Steps to configure:**

1. Copy the example config:

   ```bash
   cp build.config.example.json build.config.local.json
   ```

2. Set the `s3.teamEndpoint` to your FC endpoint URL:

   ```json
   {
     "s3": {
       "teamEndpoint": "https://your-fc-endpoint.example.com",
       "forcePathStyle": false
     }
   }
   ```

3. If your team provides a shared LLM proxy, also configure `team.llm`:

   ```json
   {
     "team": {
       "llm": {
         "baseUrl": "https://your-llm-proxy.example.com/v1",
         "model": "default",
         "modelName": "default"
       },
       "lockLlmConfig": true
     }
   }
   ```

4. Enable team mode in `features`:

   ```json
   {
     "features": {
       "teamMode": true
     }
   }
   ```

5. Rebuild the app (`pnpm tauri:dev` or `pnpm tauri:build`) for changes to take effect.

**Self-hosting the FC backend:**

The FC source is in the `services/fc/` directory. It requires:
- Node.js 20 runtime
- Alibaba Cloud OSS (or S3-compatible storage) for team data
- (Optional) LiteLLM proxy for shared AI budget management

Environment variables needed: `ACCESS_KEY_ID`, `ACCESS_KEY_SECRET`, `ROLE_ARN`, `BUCKET`, `REGION`, `ENDPOINT`. See `services/fc/s.yaml` for the full list.

### Shared Content

The team repository automatically syncs the following:

- **Skills**: `skills/` - Shared Agent skills
- **MCP Config**: `.mcp/` - MCP server configurations
- **Knowledge Base**: `knowledge/` - Team knowledge base documents

Personal files and workspace configurations are never synced, ensuring privacy.

### Auto Sync

- Automatically syncs on app startup
- Manual sync available in Settings > Team
- View last sync timestamp

### Notes

- The workspace must not already have a `.git` directory (to avoid conflicts)
- Git authentication must be configured (SSH key or HTTPS token)
- Shared files follow the remote repository; local changes will be overwritten

### Development Commands

```bash
# Start frontend only (no Tauri)
pnpm dev

# Start full Tauri app
pnpm tauri dev

# Or use the alias
pnpm tauri:dev
```

### Build

```bash
pnpm tauri:build
```

### Testing

#### Unit Tests

```bash
# Run all unit tests
pnpm test:unit

# Run tests in watch mode
pnpm --filter @teamclaw/app test:unit --watch
```

#### E2E Tests (Tauri-mcp)

E2E tests use `tauri-mcp` to interact with the running Tauri application, providing native UI automation.

**Prerequisites:**

- Install `tauri-mcp`: `cargo install tauri-mcp`
- Build the Tauri app: `pnpm tauri:build`

**Run E2E tests (from repo root; requires built Tauri app and tauri-mcp):**

```bash
# Run all E2E tests
pnpm test:e2e

# By category
pnpm test:e2e:regression
pnpm test:e2e:performance
pnpm test:e2e:e2e
pnpm test:e2e:functional

# Smoke subset
pnpm test:smoke
```

See `[packages/app/e2e/README.md](./packages/app/e2e/README.md)` and `tests/` for E2E layout.

## Project Structure

```
teamclaw/
├── packages/
│   └── app/                 # React frontend
│       └── src/
│           ├── components/
│           │   ├── editors/      # File editors
│           │   │   ├── TiptapMarkdownEditor.tsx  # Markdown WYSIWYG editor
│           │   │   ├── TiptapHtmlEditor.tsx       # HTML editor
│           │   │   ├── CodeEditor.tsx             # CodeMirror 6 code editor
│           │   │   ├── git-gutter.ts              # Git gutter decorations
│           │   │   ├── image-paste-handler.ts     # Clipboard image upload
│           │   │   ├── utils.ts                   # File type routing
│           │   │   └── types.ts                   # Shared editor props
│           │   ├── diff/         # Diff renderer
│           │   │   ├── DiffRenderer.tsx           # Main diff view
│           │   │   ├── DiffHeader.tsx             # File info + Agent actions
│           │   │   ├── HunkView.tsx               # Hunk rendering + selection
│           │   │   ├── HunkNavigator.tsx          # Mini-map navigation
│           │   │   ├── diff-ast.ts                # Unified diff parser
│           │   │   ├── shiki-renderer.ts          # Syntax highlighting
│           │   │   └── agent-operations.ts        # Agent prompt templates
│           │   └── ...           # Other UI components
│           ├── hooks/       # React hooks
│           ├── lib/         # Utilities
│           ├── stores/      # Zustand stores
│           └── styles/      # Global styles
├── apps/desktop/              # Tauri backend
│   └── src/
│       └── commands/       # Rust commands
├── doc/                    # Documentation
└── package.json
```

## Editor Architecture

The file editor routes to specialized editors based on file type:

- **Markdown files** (`.md`, `.mdx`): Tiptap WYSIWYG editor with markdown extension, preview toggle, and clipboard image paste/upload
- **HTML files** (`.html`, `.htm`): Tiptap HTML editor with sandboxed iframe preview
- **Code files** (everything else): CodeMirror 6 with syntax highlighting, line numbers, code folding, and git gutter decorations

### Diff Renderer

The custom diff renderer provides an Agent-first code review experience:

- Parses unified diff output into a structured AST (files > hunks > lines)
- Supports line-level, hunk-level, and file-level selection
- Integrates with the Agent chat via "Send to Agent" with operations: Review, Explain, Refactor, Generate Patch
- Virtual scrolling for large diffs (IntersectionObserver-based lazy rendering)
- Syntax highlighting via Shiki with on-demand language loading

## License

MIT

# TeamClaw

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![CI](https://github.com/diffrent-ai-studio/teamclaw/actions/workflows/ci.yml/badge.svg)](https://github.com/diffrent-ai-studio/teamclaw/actions)
[![Contributors](https://img.shields.io/github/contributors/diffrent-ai-studio/teamclaw.svg)](https://github.com/diffrent-ai-studio/teamclaw/graphs/contributors)

Local AI agents built on OpenCode — your AI Ally for every role

> **Your Ally. Together.**

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
- OpenCode integration for Agent capabilities
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
- **Agent**: OpenCode
- **Editors**: Tiptap (Markdown/HTML), CodeMirror 6 (Code)
- **Diff**: Custom Diff Renderer with Shiki syntax highlighting

## Install

Download the installer for your platform from [GitHub Releases](https://github.com/diffrent-ai-studio/teamclaw/releases) (`.dmg` for macOS, `.exe` for Windows).

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
- OpenCode CLI

### Install OpenCode CLI

```bash
# macOS / Linux
curl -fsSL https://opencode.ai/install | bash

# Or via npm
npm install -g opencode
```

### Quick Start

```bash
# 1. Install dependencies
pnpm install

# 2. Download OpenCode sidecar binary (required, not in git)
./src-tauri/binaries/download-opencode.sh

# 3. (Optional) Build MCP sidecars for OpenCode — see src-tauri/binaries/README.md
#    Tauri externalBin currently only bundles OpenCode; rag-mcp-server / autoui-mcp-server
#    are for opencode.json if you use local MCP binaries.

# 4. Start Tauri dev
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

> **MCP binaries**: For local RAG MCP use the standalone `rag-mcp-server` build (not an in-app HTTP bridge). Optional sidecar build steps are in [src-tauri/binaries/README.md](src-tauri/binaries/README.md).

### Update OpenCode

OpenCode releases frequently. Update to the latest version with a single command:

```bash
pnpm update-opencode
```

Skips automatically if already up to date. You can also pin a version: `pnpm update-opencode -- v1.2.1`

> **Dev mode (optional)**: Instead of downloading the sidecar, you can run OpenCode Server separately:
>
> ```bash
> cd /path/to/your/workspace && opencode serve --port 13141
> OPENCODE_DEV_MODE=true pnpm tauri dev
> ```

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
├── src-tauri/              # Tauri backend
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

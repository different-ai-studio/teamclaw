# TeamClaw

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![CI](https://github.com/diffrent-ai-studio/teamclaw/actions/workflows/ci.yml/badge.svg)](https://github.com/diffrent-ai-studio/teamclaw/actions)
[![Contributors](https://img.shields.io/github/contributors/diffrent-ai-studio/teamclaw.svg)](https://github.com/diffrent-ai-studio/teamclaw/graphs/contributors)

AI Agent Desktop Platform

English | [简体中文](README.zh-CN.md) | [繁體中文](README.zh-TW.md) | [日本語](README.ja.md) | [한국어](README.ko.md)

![TeamClaw Screenshot](_assets/screenshot.jpg)

## Features

- Three-column layout (Sidebar, Chat, Detail Panel)
- OpenCode integration for Agent capabilities
- MCP (Model Context Protocol) support for enterprise systems
- Skills/Plugins extension system
- Local file operations with permission management
- **Team Git Sync**: 团队共享仓库同步，支持共享 Skills、MCP 配置和知识库

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

## Install / 安装

从 [GitHub Releases](https://github.com/diffrent-ai-studio/teamclaw/releases) 下载对应平台的安装包（macOS 为 `.dmg`，Windows 为 `.exe`）。

- **Windows**: See [Windows Install Guide](docs/windows-install-guide.md).

### macOS 提示「已损毁」时

若从网上下载安装后打开应用时提示 **「已损毁」** 或 **「无法打开，因为无法验证开发者」**，是 macOS 安全策略（Gatekeeper）导致的。在终端执行以下命令即可解除限制并正常打开：

```bash
xattr -cr /Applications/TeamClaw.app
```

然后即可正常打开 TeamClaw。若仓库配置了 Apple 开发者签名与公证，则无需此步骤。

## Development

### Prerequisites

- Node.js >= 20
- pnpm >= 10
- Rust >= 1.70
- OpenCode CLI
- gog CLI (optional, for Google Workspace integration)

### Install OpenCode CLI

```bash
# macOS / Linux
curl -fsSL https://opencode.ai/install | bash

# 或者通过 npm 安装
npm install -g opencode
```

### Install gog CLI (optional)

[gog](https://gogcli.sh) provides Gmail, Calendar, Drive, Contacts, Sheets, and Docs access from the command line.

```bash
brew install steipete/tap/gogcli
```

Setup OAuth (once):
```bash
gog auth credentials /path/to/client_secret.json
gog auth add you@gmail.com --services gmail,calendar,drive,contacts,sheets,docs
```

### Quick Start

```bash
# 1. Install dependencies
pnpm install

# 2. Download OpenCode sidecar binary (required, not in git)
./src-tauri/binaries/download-opencode.sh

# 3. Build MCP sidecar binaries (required for tauri dev/build)
./build-bridge.sh
cp src-tauri/binaries/rag-mcp-bridge src-tauri/binaries/rag-mcp-bridge-$(rustc -vV | grep '^host:' | awk '{print $2}')

cargo build --release --manifest-path autoui-mcp/Cargo.toml
cp autoui-mcp/target/release/autoui-mcp src-tauri/binaries/autoui-mcp-server-$(rustc -vV | grep '^host:' | awk '{print $2}')
chmod +x src-tauri/binaries/autoui-mcp-server-*

# 4. Start Tauri dev
pnpm tauri dev
```

启动后，在 TeamClaw 界面中选择一个 Workspace 目录即可。

> **MCP 二进制说明**：`rag-mcp-bridge` 桥接知识库搜索；`autoui-mcp-server` 提供桌面自动化能力。两者需预先构建，否则 `pnpm tauri dev` 会因缺少 `binaries/rag-mcp-bridge-<target>` 和 `binaries/autoui-mcp-server-<target>` 而失败。详见 [src-tauri/binaries/README.md](src-tauri/binaries/README.md)。

### Update OpenCode

OpenCode 发版频繁，随时可以一条命令更新到最新版：

```bash
pnpm update-opencode
```

如果已是最新版会自动跳过。也可以指定版本：`pnpm update-opencode -- v1.2.1`

> **Dev mode (可选)**：也可以不下载 sidecar，而是单独运行 OpenCode Server：
>
> ```bash
> cd /path/to/your/workspace && opencode serve --port 13141
> OPENCODE_DEV_MODE=true pnpm tauri dev
> ```

## Team Collaboration / 团队协作

TeamClaw 支持通过 Git 仓库实现团队协作，团队成员可以共享 Skills、MCP 配置和知识库。

### 配置团队共享仓库

1. 打开 **Settings** > **Team**
2. 输入团队 Git 仓库地址（支持 HTTPS 或 SSH）
3. 点击「连接」按钮
4. TeamClaw 会自动：
  - 初始化本地 Git 仓库
  - 拉取远程仓库内容
  - 生成白名单 `.gitignore`（只同步共享层目录）

### 共享内容

团队仓库会自动同步以下内容：

- **Skills**: `.agent/skills/` - 共享的 Agent 技能
- **MCP 配置**: `.mcp/` - MCP 服务器配置
- **知识库**: `knowledge/` - 团队知识库文档

个人文件和工作区配置不会被同步，确保隐私安全。

### 自动同步

- 应用启动时自动同步最新内容
- 可在 Settings > Team 中手动触发同步
- 查看最后同步时间

### 注意事项

- 工作区不能已有 `.git` 目录（避免冲突）
- 需要配置 Git 认证（SSH key 或 HTTPS token）
- 共享层文件以远程仓库为准，本地修改会被覆盖

### Development Commands

```bash
# 仅启动前端（不含 Tauri）
pnpm dev

# 启动完整 Tauri 应用
pnpm tauri dev

# 或使用别名
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
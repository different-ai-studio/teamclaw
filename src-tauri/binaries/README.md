# TeamClaw MCP 服务器二进制文件

此目录包含用于 OpenCode MCP 集成的预编译二进制文件。Tauri 构建需要以下文件（`tauri.conf.json` 的 `externalBin`）：

| 所需文件 | 用途 |
|----------|------|
| `opencode-<target>` | OpenCode 侧进程，由下载脚本获取 |
| `rag-mcp-server-<target>` | 独立 RAG MCP Server（libSQL 向量检索） |
| `autoui-mcp-server-<target>` | 桌面自动化 MCP Server |

`<target>` 为 Rust target triple，如 `aarch64-apple-darwin`、`x86_64-pc-windows-msvc`（Windows 下带 `.exe`）。缺失任一文件会导致 `pnpm tauri dev` 失败。

## OpenCode 下载

克隆仓库后需先下载 OpenCode 二进制（未纳入 git）。

**Unix (macOS/Linux):**
```bash
./src-tauri/binaries/download-opencode.sh
# 或: pnpm update-opencode
```

**Windows (PowerShell):**
```powershell
.\src-tauri\binaries\download-opencode.ps1
# 或: pnpm update-opencode
```

指定版本时传入 tag，例如：`./src-tauri/binaries/download-opencode.sh v1.2.1`。

| 平台 | 文件名 |
|------|--------|
| macOS ARM (M1/M2/M3) | `opencode-aarch64-apple-darwin` |
| macOS Intel | `opencode-x86_64-apple-darwin` |
| Linux x86_64 | `opencode-x86_64-unknown-linux-gnu` |
| Windows x64 | `opencode-x86_64-pc-windows-msvc.exe` |

> Unix 需安装 [GitHub CLI (`gh`)](https://cli.github.com/) 并登录；Windows 使用 GitHub API 直接下载。

## 快速构建（开发环境）

### rag-mcp-server / autoui-mcp-server（Tauri sidecar）

**Unix:**
```bash
./src-tauri/binaries/build-rag-mcp-server.sh
./src-tauri/binaries/build-autoui-mcp-server.sh
```

**Windows (PowerShell):**
```powershell
.\src-tauri\binaries\build-rag-mcp-server.ps1
.\src-tauri\binaries\build-autoui-mcp-server.ps1
```

支持 debug 构建（Unix: `--debug`，Windows: `-Debug`）。

### 其他构建方式（rag-mcp-bridge / autoui-mcp）

若使用 rag-mcp-bridge 或 autoui-mcp crate，从项目根目录执行：

```bash
# 1. rag-mcp-bridge
./build-bridge.sh
cp src-tauri/binaries/rag-mcp-bridge src-tauri/binaries/rag-mcp-bridge-$(rustc -vV | grep '^host:' | awk '{print $2}')

# 2. autoui-mcp-server（来自 autoui-mcp crate）
cargo build --release --manifest-path autoui-mcp/Cargo.toml
cp autoui-mcp/target/release/autoui-mcp src-tauri/binaries/autoui-mcp-server-$(rustc -vV | grep '^host:' | awk '{print $2}')
chmod +x src-tauri/binaries/autoui-mcp-server-*
```

> 需安装 Rust 工具链（[rustup](https://rustup.rs/)）。

## 文件列表

### opencode
- **用途**: OpenCode 侧进程，由下载脚本获取
- **构建**: 见上方「OpenCode 下载」

### rag-mcp-bridge
- **用途**: 桥接知识库搜索，通过 HTTP 调用 TeamClaw 后端
- **源码**: `rag-mcp-bridge/`
- **构建**: `./build-bridge.sh`（需再复制到带 target triple 的文件名）

### rag-mcp-server
- **用途**: 独立 RAG MCP Server（libSQL 向量检索），CI 构建用
- **源码**: `rag-mcp-server/`
- **构建**: `./src-tauri/binaries/build-rag-mcp-server.sh`（Unix）/ `build-rag-mcp-server.ps1`（Windows）

### autoui-mcp-server
- **用途**: 桌面自动化 MCP Server
- **源码**: `autoui-mcp-server/` 或 `autoui-mcp/`（crate 名为 autoui-mcp 时输出需命名为 autoui-mcp-server）
- **构建**: `./src-tauri/binaries/build-autoui-mcp-server.sh`（Unix）/ `build-autoui-mcp-server.ps1`（Windows），或见上方「快速构建」中的 cargo 命令

## 命名约定

二进制文件按以下格式命名:
```
<服务名>-<target-triple>
```

Windows 下为 `<服务名>-<target-triple>.exe`。示例:
- `autoui-mcp-server-x86_64-apple-darwin` (macOS Intel)
- `autoui-mcp-server-aarch64-apple-darwin` (macOS Apple Silicon)
- `autoui-mcp-server-x86_64-pc-windows-msvc.exe` (Windows)

## OpenCode 配置

`opencode.json` 中 RAG 使用 `rag-mcp-bridge` 或 `rag-mcp-server`，autoui 可用 `pnpm dlx autoui-mcp@latest` 或本地二进制。本地 rag-mcp-bridge 路径示例：

```json
{
  "mcp": {
    "rag": {
      "type": "local",
      "command": ["./src-tauri/binaries/rag-mcp-bridge"],
      "environment": { "TEAMCLAW_TAURI_PORT": "13143", ... }
    }
  }
}
```

## 跨平台构建

为指定 target 构建时，将 `$(rustc -vV | grep '^host:' | awk '{print $2}')` 替换为目标 triple，例如 `aarch64-apple-darwin`、`x86_64-apple-darwin`、`x86_64-pc-windows-msvc`。

## 许可证

- rag-mcp-bridge: MIT License
- autoui-mcp: MIT License
- rag-mcp-server: MIT License

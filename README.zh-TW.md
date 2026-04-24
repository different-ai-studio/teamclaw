# TeamClaw

基於 OpenCode 打造的本地智慧體，你的 AI 搭檔

> **你的搭檔，並肩同行。**

- **👥 為團隊而生** — Skills、知識庫、快捷入口可透過 Git 或 S3/OSS 在團隊內共享，同時保留每位成員的私有上下文
- **🎭 Skills × 角色** — 可組合的角色庫，讓同一個智慧體適配銷售、客服、營運、研發等各類職位
- **🔋 開箱即用** — 內建 RAG 知識庫、Auto UI 視覺辨識、瀏覽器控制以及六大通道閘道（企業微信、飛書、Discord、Kook、微信、Email），無需膠水程式碼
- **🧑‍💻 個人到中小企業** — 本地優先、預設私有、零維運；從單人使用擴展到小型公司

[English](README.md) | [简体中文](README.zh-CN.md) | 繁體中文 | [日本語](README.ja.md) | [한국어](README.ko.md)

## 功能特性

- **三欄佈局** — 側邊欄、聊天區、詳情面板
- **OpenCode 整合** — 完整的 Agent 能力支援
- **MCP 支援** — Model Context Protocol，連接企業系統
- **Skills / 外掛擴充** — 可擴充的技能系統
- **本地檔案操作** — 帶權限管理的檔案讀寫

## 介面截圖

### 首頁

![TeamClaw 首頁](images/home.png)

### 頻道

![TeamClaw 頻道](images/channel.png)

### 團隊

![TeamClaw 團隊](images/team.png)

## 技術棧

- **桌面端**：Tauri 2.0 (Rust)
- **前端**：React 19 + TypeScript
- **樣式**：Tailwind CSS 4
- **狀態**：Zustand
- **Agent**：OpenCode
- **編輯器**：Tiptap (Markdown/HTML)、CodeMirror 6 (程式碼)
- **Diff**：自訂 Diff 渲染器，Shiki 語法高亮

## 安裝

從 [GitHub Releases](https://github.com/different-ai-studio/teamclaw/releases) 下載對應平台的安裝包（macOS 為 `.dmg`）。

### macOS 提示「已損毀」時

若從網路下載安裝後開啟應用時提示 **「已損毀」** 或 **「無法開啟，因為無法驗證開發者」**，是 macOS 安全策略（Gatekeeper）所致。在終端機執行以下指令即可解除限制並正常開啟：

```bash
xattr -cr /Applications/TeamClaw.app
```

然後即可正常開啟 TeamClaw。若倉庫已設定 Apple 開發者簽章與公證，則無需此步驟。

## 開發

### 前置需求

- Node.js >= 20
- pnpm >= 10
- Rust >= 1.70
- OpenCode CLI

### 安裝 OpenCode CLI

```bash
# macOS / Linux
curl -fsSL https://opencode.ai/install | bash

# 或透過 npm 安裝
npm install -g opencode
```

### 快速開始

```bash
# 1. 安裝依賴
pnpm install

# 2. 下載 OpenCode sidecar 二進位檔（必需，不在 git 中）
./src-tauri/binaries/download-opencode.sh

# 3. 啟動 Tauri 開發模式
pnpm tauri dev
```

啟動後，在 TeamClaw 介面中選擇一個 Workspace 目錄即可。

### 更新 OpenCode

OpenCode 發版頻繁，可隨時以一條指令更新至最新版：

```bash
pnpm update-opencode
```

若已是最新版會自動略過。也可指定版本：`pnpm update-opencode -- v1.2.1`

> **開發模式（可選）**：也可不下載 sidecar，改為單獨執行 OpenCode Server：
>
> ```bash
> cd /path/to/your/workspace && opencode serve --port 13141
> OPENCODE_DEV_MODE=true pnpm tauri dev
> ```

## 團隊協作

TeamClaw 支援透過 Git 倉庫進行團隊協作，團隊成員可共享 Skills、MCP 設定與知識庫。

### 設定團隊共享倉庫

1. 開啟 **Settings** > **Team**
2. 輸入團隊 Git 倉庫網址（支援 HTTPS 或 SSH）
3. 點擊「連線」按鈕
4. TeamClaw 會自動：
   - 初始化本地 Git 倉庫
   - 拉取遠端倉庫內容
   - 產生白名單 `.gitignore`（只同步共享層目錄）

### 共享內容

團隊倉庫會自動同步以下內容：

- **Skills**：`.agent/skills/` — 共享的 Agent 技能
- **MCP 設定**：`.mcp/` — MCP 伺服器設定
- **知識庫**：`knowledge/` — 團隊知識庫文件

個人檔案與工作區設定不會被同步，確保隱私安全。

### 自動同步

- 應用啟動時自動同步最新內容
- 可在 Settings > Team 中手動觸發同步
- 查看最後同步時間

### 注意事項

- 工作區不能已有 `.git` 目錄（避免衝突）
- 需設定 Git 認證（SSH key 或 HTTPS token）
- 共享層檔案以遠端倉庫為準，本地修改會被覆蓋

### 開發指令

```bash
# 僅啟動前端（不含 Tauri）
pnpm dev

# 啟動完整 Tauri 應用
pnpm tauri dev

# 或使用別名
pnpm tauri:dev
```

### 構建

```bash
pnpm tauri:build
```

### 測試

#### 單元測試

```bash
# 執行所有單元測試
pnpm test:unit

# 監聽模式執行測試
pnpm --filter @teamclaw/app test:unit --watch
```

#### E2E 測試（Tauri-mcp）

E2E 測試使用 `tauri-mcp` 與執行的 Tauri 應用互動，提供原生 UI 自動化。

**前置需求：**

- 安裝 `tauri-mcp`：`cargo install tauri-mcp`
- 構建 Tauri 應用：`pnpm tauri:build`

**執行 E2E 測試（需在倉庫根目錄；需先構建 Tauri 應用並安裝 tauri-mcp）：**

```bash
# 執行全部 E2E
pnpm test:e2e

# 按分類執行
pnpm test:e2e:regression
pnpm test:e2e:performance
pnpm test:e2e:e2e
pnpm test:e2e:functional

# 僅 Smoke
pnpm test:smoke
```

詳見 `[packages/app/e2e/README.md](./packages/app/e2e/README.md)` 與 `tests/` 目錄。

## 專案結構

```
teamclaw/
├── packages/
│   └── app/                 # React 前端
│       └── src/
│           ├── components/
│           │   ├── editors/      # 檔案編輯器
│           │   ├── diff/         # Diff 渲染器
│           │   └── ...           # 其他 UI 元件
│           ├── hooks/
│           ├── lib/
│           ├── stores/
│           └── styles/
├── src-tauri/              # Tauri 後端
│   └── src/
│       └── commands/       # Rust 指令
├── doc/                    # 文件
└── package.json
```

## 編輯器架構

檔案編輯器依檔案類型路由至不同專用編輯器：

- **Markdown 檔案**（`.md`、`.mdx`）：Tiptap 所見即所得編輯器，支援 Markdown 擴充、預覽切換與剪貼簿圖片貼上傳送
- **HTML 檔案**（`.html`、`.htm`）：Tiptap HTML 編輯器，沙箱 iframe 預覽
- **程式碼檔案**（其他類型）：CodeMirror 6，語法高亮、行號、程式碼摺疊與 Git gutter 裝飾

### Diff 渲染器

自訂 Diff 渲染器提供 Agent 優先的程式碼審查體驗：

- 將 unified diff 解析為結構化 AST（檔案 > hunk > 行）
- 支援行級、hunk 級與檔案級選擇
- 與 Agent 聊天整合，「傳送給 Agent」支援：Review、Explain、Refactor、Generate Patch
- 大檔案 diff 虛擬滾動（基於 IntersectionObserver 懶載入）
- 透過 Shiki 語法高亮，按需載入語言

## License

MIT

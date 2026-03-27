# TeamClaw

AI Agent デスクトッププラットフォーム

[English](README.md) | [简体中文](README.zh-CN.md) | [繁體中文](README.zh-TW.md) | 日本語 | [한국어](README.ko.md)

## 主な機能

- **3カラムレイアウト** — サイドバー、チャットエリア、詳細パネル
- **OpenCode 統合** — 完全な Agent 機能サポート
- **MCP サポート** — Model Context Protocol、エンタープライズシステム連携
- **Skills / プラグイン拡張** — 拡張可能なスキルシステム
- **ローカルファイル操作** — 権限管理付きのファイル読み書き
- **チーム Git 同期** — Skills、MCP 設定、ナレッジベースの共有

## UI スクリーンショット

### ホーム

![TeamClaw ホーム](images/home.png)

### チャンネル

![TeamClaw チャンネル](images/channel.png)

### チーム

![TeamClaw チーム](images/team.png)

## 技術スタック

- **デスクトップ**: Tauri 2.0 (Rust)
- **フロントエンド**: React 19 + TypeScript
- **スタイリング**: Tailwind CSS 4
- **状態管理**: Zustand
- **Agent**: OpenCode
- **エディター**: Tiptap (Markdown/HTML)、CodeMirror 6 (コード)
- **Diff**: カスタム Diff レンダラー、Shiki 構文ハイライト

## インストール

[GitHub Releases](https://github.com/diffrent-ai-studio/teamclaw/releases) からプラットフォームに対応したインストールパッケージをダウンロード（macOS は `.dmg`）。

### macOS で「壊れている」と表示される場合

ネットからダウンロードしてインストール後、アプリを開こうとすると **「壊れている」** または **「開発元を確認できないため開けません」** と表示される場合は、macOS のセキュリティポリシー（Gatekeeper）によるものです。ターミナルで以下のコマンドを実行して制限を解除すると、正常に開けます：

```bash
xattr -cr /Applications/TeamClaw.app
```

これで TeamClaw を正常に開けます。リポジトリに Apple 開発者署名と公証が設定されている場合は、この手順は不要です。

## 開発

### 必要条件

- Node.js >= 20
- pnpm >= 10
- Rust >= 1.70
- OpenCode CLI

### OpenCode CLI のインストール

```bash
# macOS / Linux
curl -fsSL https://opencode.ai/install | bash

# または npm でインストール
npm install -g opencode
```

### クイックスタート

```bash
# 1. 依存関係をインストール
pnpm install

# 2. OpenCode sidecar バイナリをダウンロード（必須、git には含まれていません）
./src-tauri/binaries/download-opencode.sh

# 3. Tauri 開発モードを起動
pnpm tauri dev
```

起動後、TeamClaw の画面で Workspace ディレクトリを選択してください。

### OpenCode の更新

OpenCode は頻繁にリリースされるため、以下のコマンドでいつでも最新版に更新できます：

```bash
pnpm update-opencode
```

既に最新版の場合は自動的にスキップされます。バージョン指定も可能：`pnpm update-opencode -- v1.2.1`

> **開発モード（オプション）**：sidecar をダウンロードせず、OpenCode Server を別途実行することもできます：
>
> ```bash
> cd /path/to/your/workspace && opencode serve --port 13141
> OPENCODE_DEV_MODE=true pnpm tauri dev
> ```

## チーム協力

TeamClaw は Git リポジトリによるチーム協力をサポートし、チームメンバーは Skills、MCP 設定、ナレッジベースを共有できます。

### チーム共有リポジトリの設定

1. **Settings** > **Team** を開く
2. チーム Git リポジトリ URL を入力（HTTPS または SSH 対応）
3. 「接続」ボタンをクリック
4. TeamClaw が自動的に：
   - ローカル Git リポジトリを初期化
   - リモートリポジトリの内容をプル
   - ホワイトリスト `.gitignore` を生成（共有層ディレクトリのみ同期）

### 共有内容

チームリポジトリは以下の内容を自動同期します：

- **Skills**：`.agent/skills/` — 共有 Agent スキル
- **MCP 設定**：`.mcp/` — MCP サーバー設定
- **ナレッジベース**：`knowledge/` — チームナレッジベースドキュメント

個人ファイルとワークスペース設定は同期されず、プライバシーが保護されます。

### 自動同期

- アプリ起動時に最新内容を自動同期
- Settings > Team で手動トリガーが可能
- 最終同期時刻を確認可能

### 注意事項

- ワークスペースに既に `.git` ディレクトリがある場合は使用できません（競合を避けるため）
- Git 認証（SSH キーまたは HTTPS トークン）の設定が必要
- 共有層ファイルはリモートリポジトリを優先し、ローカルの変更は上書きされます

### 開発コマンド

```bash
# フロントエンドのみ起動（Tauri なし）
pnpm dev

# 完全な Tauri アプリを起動
pnpm tauri dev

# またはエイリアス
pnpm tauri:dev
```

### ビルド

```bash
pnpm tauri:build
```

### テスト

#### 単体テスト

```bash
# 全単体テストを実行
pnpm test:unit

# ウォッチモードでテスト実行
pnpm --filter @teamclaw/app test:unit --watch
```

#### E2E テスト（Tauri-mcp）

E2E テストは `tauri-mcp` を使用して実行中の Tauri アプリとやり取りし、ネイティブ UI 自動化を提供します。

**必要条件：**

- `tauri-mcp` のインストール：`cargo install tauri-mcp`
- Tauri アプリのビルド：`pnpm tauri:build`

**E2E テストの実行（リポジトリルートで；Tauri ビルドと tauri-mcp が必要）：**

```bash
# 全 E2E を実行
pnpm test:e2e

# カテゴリ別
pnpm test:e2e:regression
pnpm test:e2e:performance
pnpm test:e2e:e2e
pnpm test:e2e:functional

# Smoke のみ
pnpm test:smoke
```

詳しくは `[packages/app/e2e/README.md](./packages/app/e2e/README.md)` と `tests/` を参照。

## プロジェクト構成

```
teamclaw/
├── packages/
│   └── app/                 # React フロントエンド
│       └── src/
│           ├── components/
│           │   ├── editors/      # ファイルエディター
│           │   ├── diff/         # Diff レンダラー
│           │   └── ...           # その他 UI コンポーネント
│           ├── hooks/
│           ├── lib/
│           ├── stores/
│           └── styles/
├── src-tauri/              # Tauri バックエンド
│   └── src/
│       └── commands/       # Rust コマンド
├── doc/                    # ドキュメント
└── package.json
```

## エディターアーキテクチャ

ファイルエディターはファイルタイプに応じて専門のエディターにルーティングされます：

- **Markdown ファイル**（`.md`、`.mdx`）：Tiptap WYSIWYG エディター、Markdown 拡張、プレビュー切替、クリップボード画像ペースト/アップロード対応
- **HTML ファイル**（`.html`、`.htm`）：Tiptap HTML エディター、サンドボックス iframe プレビュー
- **コードファイル**（その他）：CodeMirror 6、構文ハイライト、行番号、コード折りたたみ、Git gutter デコレーション

### Diff レンダラー

カスタム Diff レンダラーは Agent ファーストのコードレビュー体験を提供します：

- unified diff を構造化 AST（ファイル > hunk > 行）にパース
- 行レベル、hunk レベル、ファイルレベルの選択に対応
- Agent チャットと統合、「Agent に送信」で Review、Explain、Refactor、Generate Patch を実行
- 大きな diff の仮想スクロール（IntersectionObserver ベースの遅延レンダリング）
- Shiki による構文ハイライト、言語のオンデマンドロード

## License

MIT

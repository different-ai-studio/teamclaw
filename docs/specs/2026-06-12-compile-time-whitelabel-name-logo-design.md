# 编译期白标:自定义 App 名称与 Logo

**日期**: 2026-06-12
**分支**: `task/wo-xiang-zi-ding-yi-ming-cheng-helogo`
**状态**: 设计已确认,待写实现计划

## 目标

让桌面 App 的**品牌名称**和 **logo(含操作系统级图标)**在**编译期**通过
`build.config.*.json` 配置出不同的白标包。每个品牌只提供**一张方形源图**,
构建时自动生成整套图标。

**约束**:默认 / 生产配置不填 logo、名称仍为 `TeamClaw` 时,构建产物与现状
**零差异**(不产生 git diff、不改变行为)。

## 背景:现状链路

- `build.config.json` + `build.config.${BUILD_ENV}.json` + `build.config.local.json`
  经 `deepMerge` 合并(`packages/app/vite.config.ts:42-47`、
  `scripts/update-tauri-config.js:36-48`)。
- 名称:`buildConfig.app.name` 已流到前端(登录页 `LoginScreen.tsx`、关于页
  `AboutSection.tsx`、各渠道向导)。但 **Rust 侧多处硬编码 `"TeamClaw"`**
  (窗口标题 `apps/desktop/src/commands/window.rs:93`、托盘 tooltip
  `apps/desktop/src/lib.rs:578`、OAuth 回调 HTML `oauth_loopback.rs`)。
- Logo:**完全未接配置**。
  - 前端展示 logo:`packages/app/public/logo.png`(登录页,128px 显示)、
    `packages/app/public/logo-64.png`(关于页,64px 显示)。
  - OS 打包图标:`apps/desktop/tauri.conf.json:73-78` 静态引用
    `icons/32x32.png`、`icons/128x128.png`、`icons/128x128@2x.png`、
    `icons/icon.icns`、`icons/icon.ico`。
- **关键挂载点**:`scripts/update-tauri-config.js` 在每个
  `tauri:dev`/`tauri:build` 前运行,已合并 build.config 并改写
  `tauri.conf.json`(目前只改 updater)。扩展它即可,无需新脚本。
- `@tauri-apps/cli ^2.10.0` 已是依赖,自带 `tauri icon` 命令。

## 方案选型(图标生成)

- **A(采纳)`tauri icon` CLI**:在现有 prebuild 脚本里调
  `tauri icon <源图>`,一条命令从单张方图生成 `apps/desktop/icons/` 整套
  (含 `.icns`/`.ico`)。零新依赖,专用工具。
- B sharp 自写生成器:加依赖,且生不了干净的 `.icns`,需再叠工具。**否决**。
- C 每品牌预置整套图标文件夹:与「单张源图自动生成」矛盾。**否决**。

## 设计

### 1. 配置 schema(`build.config.*.json`)

`app` 下新增可选字段 `logo`:

```jsonc
"app": {
  "name": "TeamClaw",        // 已有 → 现在也驱动 OS 应用名 / 窗口标题 / Rust 文案
  "shortName": "teamclaw",   // 已有,不变
  "logo": "branding/acme/logo.png"  // 新增:方形源图(建议 1024×1024 PNG),路径相对仓库根
}
```

- `logo` 可选。**缺省 = prebuild 不做图标相关动作**,保留仓库内现有图标。
- 源图约定放在 `branding/<brand>/logo.png`。
- `build.config.example.json` 增加 `logo` 示例(指向占位约定路径)。

### 2. 构建流水线:扩展 `scripts/update-tauri-config.js`

脚本已合并 buildConfig。在其写回 `tauri.conf.json` 的逻辑里新增:

**(a) 名称 → tauri.conf**:若 `buildConfig.app.name` 有值,设置
`tauriConf.productName` 和 `tauriConf.app.windows[0].title` 为该值。

**(b) logo → 图标**:若 `buildConfig.app.logo` 有值:
1. 校验源图存在(否则报错退出,fail-fast)。
2. 调用 `tauri icon <repoRoot/app.logo>`(经 `scripts/tauri-cli.js` 或
   直接 `@tauri-apps/cli`),输出目录指向 `apps/desktop/icons/`,
   重新生成 `tauri.conf` 引用的那 5 个文件。
3. 把生成的 `apps/desktop/icons/128x128.png` 拷贝为
   `packages/app/public/logo.png` 与 `packages/app/public/logo-64.png`
   (关于页 CSS 缩到 64px,复用 128 源图即可,免引第二个工具)。

**幂等 / 默认**:无 `app.logo` 时跳过 (b);`app.name === "TeamClaw"` 时
(b) 之外写回的内容与现状一致,默认构建零 diff。

### 3. 前端

- **基本不动**:登录页 `/logo.png`、关于页 `/logo-64.png` 由 prebuild
  **替换文件**实现换 logo;`app.name` 已通过 `buildConfig.app.name` 流通。
- 仅做一次性核对,确认无遗漏的硬编码 logo 路径或 "TeamClaw" 文案。

### 4. Rust 名称白标(全链路)

将以下硬编码 `"TeamClaw"` 改为读取 Tauri 配置的 product name
(`app.config().product_name`,已由第 2(a) 步按品牌写好),回落 `"TeamClaw"`:

- `apps/desktop/src/commands/window.rs:88,93` —— 工作区窗口标题
  `format!("{productName} — {ws_name}")`,fallback 名同样用 productName。
- `apps/desktop/src/lib.rs:578` —— 托盘 tooltip。
- `apps/desktop/src/commands/oauth_loopback.rs:24,26` —— OAuth 回调页 HTML
  里的 "TeamClaw" 文案。

注:取值优先用 Tauri 运行时已解析的 product name,避免 Rust 再独立读
build.config,保证单一来源。

### 5. 约定与默认资产

- 新增 `branding/` 目录约定 + 一个示例(如
  `branding/teamclaw/logo.png` 用现有 `apps/desktop/icons/teamclaw-logo.png`
  作为可复现的默认源图,供 OEM 参考)。
- 生产 / 默认 `build.config.production.json` **不填 logo**,保证现有发布零变化。

## 副作用(需在文档/PR 说明)

品牌构建时 prebuild 会**就地覆盖**已提交的
`apps/desktop/icons/*`、`packages/app/public/logo*.png`、`tauri.conf.json`,
工作区会变脏。这对 OEM/CI 流程(checkout → 应用品牌 → 构建 → 丢弃)是**预期
行为**。默认构建(`name=TeamClaw`、无 `logo`)不产生 diff。

## 测试

- **脚本用例**(`scripts/` 下,Node):
  - 给定一个含 `app.logo`(指向测试 PNG)的临时 build.config,运行 prebuild,
    断言:`apps/desktop/icons/` 被重新生成、`tauri.conf.productName` 与
    `app.windows[0].title` 被改、`public/logo.png` 与 `logo-64.png` 被写。
  - 不含 `app.logo` 且 `name=TeamClaw` 时,断言 tauri.conf 关键字段与基线一致
    (no-op,除既有 updater 行为)。
  - 运行后**还原**被改动的工作区文件(测试不留脏)。
- **Rust**:`cargo check`/`clippy` 通过;product-name 取值逻辑可加轻量单测或
  靠类型保证 fallback。
- **手动**:`BUILD_ENV=<brand> pnpm tauri:dev` 观察新窗口标题 + 新 dock 图标 +
  登录/关于页新 logo。

## 不做(YAGNI)

- 运行时(用户在设置页)改名称/logo —— 明确排除,本次只做编译期。
- 团队 / agent / workspace 级别的名称 logo —— 不在范围。
- iOS / Android 图标的同源生成 —— 本次只针对桌面 (`apps/desktop`)。
- 自动生成 `.ico` 之外的 Windows Store logo 等额外尺寸 —— 仅覆盖
  `tauri.conf` 当前引用的图标集。

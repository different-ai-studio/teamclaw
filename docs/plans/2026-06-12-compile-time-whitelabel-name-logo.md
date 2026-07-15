# 编译期白标:自定义 App 名称与 Logo — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让桌面 App 的品牌名称和 logo(含 OS 级图标)在编译期由 `build.config.*.json` 配置,单张方形源图自动生成整套图标;默认配置下产物零差异。

**Architecture:** 扩展已在每次 `tauri:dev`/`tauri:build` 前运行的 `scripts/update-tauri-config.js`:把可复用逻辑抽到纯函数 `scripts/lib/branding.js`(可单测),脚本里(a)用 `app.name` 写 `tauri.conf` 的 `productName` + 窗口标题,(b)若有 `app.logo` 则调 `tauri icon` 生成 `apps/desktop/icons/` 整套并把 128px 拷成前端 `public/logo*.png`。Rust 侧把硬编码 `"TeamClaw"`(窗口标题/托盘/OAuth 回调页)改为读 `app.config().product_name`,经一个可单测的 `brand_name()` 兜底。

**Tech Stack:** Node(CJS 脚本 + `node --test`)、`@tauri-apps/cli` 自带的 `tauri icon`、Rust/Tauri 2、React(前端基本不改,靠文件替换换 logo)。

**Spec:** `docs/specs/2026-06-12-compile-time-whitelabel-name-logo-design.md`

---

## File Structure

- `scripts/lib/branding.js` — **新建**。纯函数:`applyNameToTauriConf()`、`resolveLogoPlan()`。无副作用,便于单测。
- `scripts/lib/branding.test.js` — **新建**。`node --test` 单测。
- `scripts/update-tauri-config.js` — **改**。require 上面的纯函数;新增 logo 生成的命令式 runner(`tauri icon` + 拷贝)。
- `packages/app/src/lib/build-config.ts` — **改**。`BuildConfig.app` 加 `logo?: string`。
- `build.config.example.json` — **改**。`app` 下加 `logo` 示例。
- `apps/desktop/src/branding.rs` — **新建**。`pub fn brand_name(Option<&str>) -> String` + 单测。
- `apps/desktop/src/lib.rs` — **改**。`mod branding;`;托盘 tooltip 用 `brand_name`。
- `apps/desktop/src/commands/window.rs` — **改**。窗口标题 / fallback 用 `brand_name`。
- `apps/desktop/src/commands/oauth_loopback.rs` — **改**。HTML 常量改成按品牌名 format 的函数。
- `branding/README.md` — **新建**。白标资产约定文档。
- `package.json` — **改**。加 `"test:scripts"` 脚本。

---

## Task 1: 配置 schema 加 `app.logo`

**Files:**
- Modify: `packages/app/src/lib/build-config.ts:36-43`(`BuildConfig.app`)
- Modify: `build.config.example.json`(`app` 块)

- [ ] **Step 1: 给 `BuildConfig.app` 加可选 `logo` 字段**

在 `packages/app/src/lib/build-config.ts` 的 `app: { ... }` 里,`palette?: string` 之后加:

```ts
    /** Build-time white-label: path (relative to repo root) to a square source
     *  PNG (≥512px, ideally 1024×1024). When set, the prebuild step regenerates
     *  the OS icon set and the in-app logo from it. Omitted → keep committed assets. */
    logo?: string
```

- [ ] **Step 2: 在 example 配置里加 logo 示例**

在 `build.config.example.json` 的 `"app"` 对象里,`"palette": "default",` 之后加一行:

```json
    "logo": "branding/acme/logo.png",
```

（example 不参与实际构建,仅作约定文档。）

- [ ] **Step 3: typecheck**

Run: `pnpm typecheck`
Expected: PASS(无新增错误)

- [ ] **Step 4: Commit**

```bash
git add packages/app/src/lib/build-config.ts build.config.example.json
git commit -m "feat(whitelabel): add app.logo to build config schema"
```

---

## Task 2: 纯函数 `applyNameToTauriConf` + 接入脚本(名称→tauri.conf)

**Files:**
- Create: `scripts/lib/branding.js`
- Create: `scripts/lib/branding.test.js`
- Modify: `package.json`(scripts 块)
- Modify: `scripts/update-tauri-config.js`

- [ ] **Step 1: 写失败测试**

新建 `scripts/lib/branding.test.js`:

```js
"use strict";
const test = require("node:test");
const assert = require("node:assert");
const { applyNameToTauriConf } = require("./branding");

test("applyNameToTauriConf sets productName and window title from app.name", () => {
  const conf = { productName: "TeamClaw", app: { windows: [{ title: "TeamClaw" }] } };
  const changed = applyNameToTauriConf(conf, { app: { name: "Acme" } });
  assert.strictEqual(changed, true);
  assert.strictEqual(conf.productName, "Acme");
  assert.strictEqual(conf.app.windows[0].title, "Acme");
});

test("applyNameToTauriConf is a no-op when app.name is absent", () => {
  const conf = { productName: "TeamClaw", app: { windows: [{ title: "TeamClaw" }] } };
  const changed = applyNameToTauriConf(conf, { app: {} });
  assert.strictEqual(changed, false);
  assert.strictEqual(conf.productName, "TeamClaw");
});

test("applyNameToTauriConf tolerates missing windows array", () => {
  const conf = { productName: "TeamClaw", app: {} };
  const changed = applyNameToTauriConf(conf, { app: { name: "Acme" } });
  assert.strictEqual(changed, true);
  assert.strictEqual(conf.productName, "Acme");
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test scripts/lib/branding.test.js`
Expected: FAIL —— `Cannot find module './branding'`

- [ ] **Step 3: 写最小实现**

新建 `scripts/lib/branding.js`:

```js
"use strict";

/**
 * Apply the configured app name to a parsed tauri.conf.json object (mutates it).
 * Sets `productName` and the first window's `title`. Returns true if anything changed.
 */
function applyNameToTauriConf(tauriConf, buildConfig) {
  const name = buildConfig && buildConfig.app && buildConfig.app.name;
  if (!name) return false;
  let changed = false;
  if (tauriConf.productName !== name) {
    tauriConf.productName = name;
    changed = true;
  }
  const win = tauriConf.app && Array.isArray(tauriConf.app.windows) && tauriConf.app.windows[0];
  if (win && win.title !== name) {
    win.title = name;
    changed = true;
  }
  return changed;
}

module.exports = { applyNameToTauriConf };
```

- [ ] **Step 4: 跑测试确认通过**

Run: `node --test scripts/lib/branding.test.js`
Expected: PASS（3 个用例全过）

- [ ] **Step 5: 加 `test:scripts` npm 脚本**

在 `package.json` 的 `"scripts"` 里,`"test:unit": ...` 之后加:

```json
    "test:scripts": "node --test scripts/lib/",
```

- [ ] **Step 6: 接入 `scripts/update-tauri-config.js`**

在文件顶部 require 区(`const path = require('path');` 之后)加:

```js
const { applyNameToTauriConf } = require('./lib/branding');
```

在 `let updated = false;`(约 53 行)之后、`function ensureUpdater()` 之前加:

```js
if (applyNameToTauriConf(tauriConf, buildConfig)) {
  console.log(`✓ Updated productName/window title: ${buildConfig.app.name}`);
  updated = true;
}
```

- [ ] **Step 7: 冒烟——默认配置零改动**

Run: `node scripts/update-tauri-config.js && git diff --stat apps/desktop/tauri.conf.json`
Expected: `apps/desktop/tauri.conf.json` 无 diff（默认 name 仍是 TeamClaw,写回内容相同）

- [ ] **Step 8: Commit**

```bash
git add scripts/lib/branding.js scripts/lib/branding.test.js scripts/update-tauri-config.js package.json
git commit -m "feat(whitelabel): drive tauri productName + window title from app.name"
```

---

## Task 3: 纯函数 `resolveLogoPlan` + 接入脚本(logo→图标生成)

**Files:**
- Modify: `scripts/lib/branding.js`
- Modify: `scripts/lib/branding.test.js`
- Modify: `scripts/update-tauri-config.js`

- [ ] **Step 1: 写失败测试**(追加到 `scripts/lib/branding.test.js` 末尾)

```js
const path = require("node:path");
const { resolveLogoPlan } = require("./branding");

test("resolveLogoPlan returns null when app.logo is absent", () => {
  assert.strictEqual(resolveLogoPlan({ app: {} }, "/repo"), null);
});

test("resolveLogoPlan builds absolute source + targets from app.logo", () => {
  const plan = resolveLogoPlan({ app: { logo: "branding/acme/logo.png" } }, "/repo");
  assert.strictEqual(plan.source, path.join("/repo", "branding/acme/logo.png"));
  assert.strictEqual(plan.iconsOutDir, path.join("/repo", "apps/desktop/icons"));
  assert.deepStrictEqual(plan.publicLogoTargets, [
    path.join("/repo", "packages/app/public/logo.png"),
    path.join("/repo", "packages/app/public/logo-64.png"),
  ]);
  assert.strictEqual(plan.generatedIcon, path.join("/repo", "apps/desktop/icons", "128x128.png"));
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test scripts/lib/branding.test.js`
Expected: FAIL —— `resolveLogoPlan is not a function`

- [ ] **Step 3: 实现 `resolveLogoPlan`**(加到 `scripts/lib/branding.js`,并加进 `module.exports`)

```js
const path = require("path");

/**
 * Build a (side-effect-free) plan describing how to regenerate icons from
 * buildConfig.app.logo. Returns null when no logo is configured.
 */
function resolveLogoPlan(buildConfig, repoRoot) {
  const logo = buildConfig && buildConfig.app && buildConfig.app.logo;
  if (!logo) return null;
  const iconsOutDir = path.join(repoRoot, "apps/desktop/icons");
  return {
    source: path.join(repoRoot, logo),
    iconsOutDir,
    generatedIcon: path.join(iconsOutDir, "128x128.png"),
    publicLogoTargets: [
      path.join(repoRoot, "packages/app/public/logo.png"),
      path.join(repoRoot, "packages/app/public/logo-64.png"),
    ],
  };
}

module.exports = { applyNameToTauriConf, resolveLogoPlan };
```

（注意:把已有的 `module.exports = { applyNameToTauriConf };` 替换成上面这行同时导出两者。）

- [ ] **Step 4: 跑测试确认通过**

Run: `node --test scripts/lib/branding.test.js`
Expected: PASS（全部用例)

- [ ] **Step 5: 接入命令式 runner 到 `scripts/update-tauri-config.js`**

在 require 区把上一行改为:

```js
const { applyNameToTauriConf, resolveLogoPlan } = require('./lib/branding');
```

文件顶部 require 区加:

```js
const { execFileSync } = require('child_process');
```

在 Task 2 加的 name 块之后、`function ensureUpdater()` 之前加:

```js
const logoPlan = resolveLogoPlan(buildConfig, rootDir);
if (logoPlan) {
  if (!fs.existsSync(logoPlan.source)) {
    console.error(`✗ app.logo source not found: ${logoPlan.source}`);
    process.exit(1);
  }
  console.log(`✓ Generating icon set from ${logoPlan.source}`);
  // Use the @tauri-apps/cli binary directly (NOT the `tauri` npm script, which
  // rebuilds sidecars). `pnpm exec tauri` resolves node_modules/.bin/tauri.
  execFileSync('pnpm', ['exec', 'tauri', 'icon', logoPlan.source, '-o', logoPlan.iconsOutDir], {
    cwd: rootDir,
    stdio: 'inherit',
  });
  for (const target of logoPlan.publicLogoTargets) {
    fs.copyFileSync(logoPlan.generatedIcon, target);
    console.log(`✓ Wrote in-app logo: ${target}`);
  }
  updated = true;
}
```

- [ ] **Step 6: 冒烟——无 logo 时不触发生成**

Run: `node scripts/update-tauri-config.js && git diff --stat apps/desktop/icons packages/app/public`
Expected: 无 diff（生产/默认配置无 `app.logo`,runner 跳过）

- [ ] **Step 7: 冒烟——有 logo 时真的重生成**(临时验证,产物不提交)

```bash
# 用现有图标当临时源图,造一个本地 override
cp apps/desktop/icons/128x128.png /tmp/wl-src.png
printf '{"app":{"logo":"%s"}}\n' "/tmp/wl-src.png" > build.config.local.json
node scripts/update-tauri-config.js
ls -la apps/desktop/icons/icon.icns apps/desktop/icons/icon.ico packages/app/public/logo.png
# 清理,务必不留脏
rm build.config.local.json
git checkout -- apps/desktop/icons packages/app/public/logo.png packages/app/public/logo-64.png apps/desktop/tauri.conf.json
```

注:`resolveLogoPlan` 把 `path.join(repoRoot, logo)` 当源;绝对路径的 logo 在 `path.join` 下仍解析为该绝对路径(POSIX),临时验证可用。生产用相对仓库根路径。
Expected: 命令成功,icns/ico/logo.png 时间戳被更新;清理后 `git status` 干净

- [ ] **Step 8: Commit**

```bash
git add scripts/lib/branding.js scripts/lib/branding.test.js scripts/update-tauri-config.js
git commit -m "feat(whitelabel): regenerate OS icon set + in-app logo from app.logo"
```

---

## Task 4: Rust 名称白标——`brand_name` 助手 + 窗口标题 + 托盘

**Files:**
- Create: `apps/desktop/src/branding.rs`
- Modify: `apps/desktop/src/lib.rs`(加 `mod branding;` + 托盘 tooltip)
- Modify: `apps/desktop/src/commands/window.rs:88-93`

- [ ] **Step 1: 写带单测的 `brand_name` 助手**

新建 `apps/desktop/src/branding.rs`:

```rust
//! Compile-time white-label helpers. The brand name comes from the Tauri
//! config `productName` (written at build time by scripts/update-tauri-config.js
//! from build.config `app.name`), falling back to "TeamClaw".

/// Resolve the brand display name from an optional configured product name.
pub fn brand_name(configured: Option<&str>) -> String {
    configured
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .unwrap_or("TeamClaw")
        .to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn falls_back_when_none() {
        assert_eq!(brand_name(None), "TeamClaw");
    }

    #[test]
    fn falls_back_when_empty() {
        assert_eq!(brand_name(Some("")), "TeamClaw");
        assert_eq!(brand_name(Some("   ")), "TeamClaw");
    }

    #[test]
    fn uses_configured_name() {
        assert_eq!(brand_name(Some("Acme")), "Acme");
    }
}
```

- [ ] **Step 2: 在 `lib.rs` 声明模块**

在 `apps/desktop/src/lib.rs` 顶部其它 `mod` 声明附近加:

```rust
mod branding;
```

- [ ] **Step 3: 跑单测确认 `brand_name` 通过**

Run: `cargo test --manifest-path apps/desktop/Cargo.toml branding::`
Expected: PASS（3 个用例）

- [ ] **Step 4: 托盘 tooltip 用 `brand_name`**

在 `apps/desktop/src/lib.rs:578`,把:

```rust
                .tooltip("TeamClaw")
```

改为(`app` 在该 setup 闭包内可用):

```rust
                .tooltip(branding::brand_name(app.config().product_name.as_deref()))
```

- [ ] **Step 5: 窗口标题用 `brand_name`**

在 `apps/desktop/src/commands/window.rs`,把第 88-93 行:

```rust
    let ws_name = std::path::Path::new(&workspace_path)
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("TeamClaw");
    let window_title = format!("TeamClaw — {}", ws_name);
```

改为:

```rust
    let brand = crate::branding::brand_name(app.config().product_name.as_deref());
    let ws_name = std::path::Path::new(&workspace_path)
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or(brand.as_str());
    let window_title = format!("{} — {}", brand, ws_name);
```

- [ ] **Step 6: 编译 + clippy**

Run: `cargo clippy --manifest-path apps/desktop/Cargo.toml -- -D warnings`
Expected: PASS（无 warning/error）

- [ ] **Step 7: Commit**

```bash
git add apps/desktop/src/branding.rs apps/desktop/src/lib.rs apps/desktop/src/commands/window.rs
git commit -m "feat(whitelabel): derive window title + tray tooltip from product name"
```

---

## Task 5: Rust——OAuth 回调页文案跟随品牌名

**Files:**
- Modify: `apps/desktop/src/commands/oauth_loopback.rs`

- [ ] **Step 1: 写失败测试**(追加到 `oauth_loopback.rs` 末尾,或文件已有 `#[cfg(test)]` 则并入)

```rust
#[cfg(test)]
mod brand_html_tests {
    use super::{error_html, success_html};

    #[test]
    fn success_html_includes_brand_name() {
        let html = success_html("Acme");
        assert!(html.contains("Acme"));
        assert!(!html.contains("TeamClaw"));
    }

    #[test]
    fn error_html_includes_brand_name() {
        let html = error_html("Acme");
        assert!(html.contains("Acme"));
        assert!(!html.contains("TeamClaw"));
    }
}
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cargo test --manifest-path apps/desktop/Cargo.toml brand_html_tests::`
Expected: FAIL —— `cannot find function success_html` / `error_html`

- [ ] **Step 3: 把 HTML 常量改成按名 format 的函数**

把 `apps/desktop/src/commands/oauth_loopback.rs:23-31` 的两个 `const` 删除,替换为:

```rust
fn success_html(brand: &str) -> String {
    format!(
        "<!doctype html><meta charset=utf-8><title>{brand}</title>\
         <body style=\"font-family:system-ui;text-align:center;padding-top:18vh\">\
         <h2>登录成功 / Signed in</h2><p>你可以关闭此页面返回 {brand}。<br>You can close this tab.</p></body>"
    )
}

fn error_html(brand: &str) -> String {
    format!(
        "<!doctype html><meta charset=utf-8><title>{brand}</title>\
         <body style=\"font-family:system-ui;text-align:center;padding-top:18vh\">\
         <h2>登录失败 / Sign-in failed</h2><p>请返回 {brand} 重试。<br>Please return to {brand} and try again.</p></body>"
    )
}
```

- [ ] **Step 4: 给 `oauth_loopback_start` 注入 `AppHandle` 并把品牌名传进 spawn 的任务**

在 `oauth_loopback_start`(约 52 行)的参数列表加一个 `app: tauri::AppHandle`(Tauri 自动注入,前端 invoke 不变)。需要 `use tauri::Manager;`(若未引入)以调用 `app.config()`。在 spawn 闭包之前求值品牌名:

```rust
let brand = crate::branding::brand_name(app.config().product_name.as_deref());
```

把 `brand` 通过 `move` 闭包带入(`tokio::spawn(async move { ... })`)。

在第 141-142 行,把:

```rust
        Ok(_) => ("200 OK", SUCCESS_HTML),
        Err(_) => ("400 Bad Request", ERROR_HTML),
```

改为先算出字符串再用引用(保持后续写响应的借用有效):

```rust
        Ok(_) => ("200 OK", success_html(&brand)),
        Err(_) => ("400 Bad Request", error_html(&brand)),
```

若该 `match` 的结果类型此前是 `(&str, &'static str)`,改为 `(&str, String)`;后续把 HTML 写入响应处用 `body.as_bytes()` / `&body` 即可(String 解引用为 &str)。如出现借用/类型不匹配,按编译器提示把元组第二元素类型统一为 `String`。

- [ ] **Step 5: 跑测试 + clippy 确认通过**

Run: `cargo test --manifest-path apps/desktop/Cargo.toml brand_html_tests:: && cargo clippy --manifest-path apps/desktop/Cargo.toml -- -D warnings`
Expected: PASS（测试 2/2 + clippy 净）

- [ ] **Step 6: Commit**

```bash
git add apps/desktop/src/commands/oauth_loopback.rs
git commit -m "feat(whitelabel): brand OAuth loopback success/error pages"
```

---

## Task 6: 白标资产约定文档

**Files:**
- Create: `branding/README.md`

- [ ] **Step 1: 写约定文档**

新建 `branding/README.md`:

```markdown
# 白标资产(编译期)

每个品牌一张方形源图,放在 `branding/<brand>/logo.png`(建议 1024×1024 PNG)。

在对应的构建配置里指向它:

```jsonc
// build.config.<brand>.json
{
  "app": {
    "name": "Acme",
    "shortName": "acme",
    "logo": "branding/acme/logo.png"
  }
}
```

构建前 `scripts/update-tauri-config.js`(在 `tauri:dev`/`tauri:build` 前自动运行)会:

1. 用 `app.name` 写入 `apps/desktop/tauri.conf.json` 的 `productName` 与窗口标题;
   Rust 侧窗口标题/托盘/OAuth 回调页文案也跟随该名(回落 `TeamClaw`)。
2. 用 `app.logo` 跑 `tauri icon` 生成 `apps/desktop/icons/` 整套 OS 图标
   (32/128/128@2x/.icns/.ico),并把 128px 拷成 `packages/app/public/logo.png`
   与 `logo-64.png`(登录页 / 关于页展示)。

## 用法

```bash
BUILD_ENV=acme pnpm tauri:build      # 出 Acme 品牌包
BUILD_ENV=acme pnpm tauri:dev        # 本地预览
```

## 注意

- **不填 `app.logo` 且 `name=TeamClaw` → 产物零差异**,沿用仓库内已提交的图标。
- 品牌构建会**就地覆盖**已提交的图标 / `public/logo*.png` / `tauri.conf.json`,
  工作区会变脏。CI/OEM 流程应 checkout → 应用品牌 → 构建 → 丢弃改动。
- 纯前端 `pnpm dev`(不经 Tauri)不会触发图标生成,显示的是当前已提交的 logo。
```

- [ ] **Step 2: Commit**

```bash
git add branding/README.md
git commit -m "docs(whitelabel): document branding asset convention"
```

---

## Task 7: 全量验证

- [ ] **Step 1: 脚本单测**

Run: `pnpm test:scripts`
Expected: PASS（branding.test.js 全过）

- [ ] **Step 2: 前端 typecheck + 单测**

Run: `pnpm typecheck && pnpm test:unit`
Expected: PASS（无新增失败;预存在的 main 红除外)

- [ ] **Step 3: Rust 编译 + clippy + 单测**

Run: `cargo clippy --manifest-path apps/desktop/Cargo.toml -- -D warnings && cargo test --manifest-path apps/desktop/Cargo.toml branding:: brand_html_tests::`
Expected: PASS

- [ ] **Step 4: 默认零 diff 校验**

Run: `node scripts/update-tauri-config.js && git status --porcelain apps/desktop/tauri.conf.json apps/desktop/icons packages/app/public`
Expected: 输出为空（默认配置不产生改动）

- [ ] **Step 5(手动): 品牌包冒烟**

```bash
# 准备一个测试品牌
mkdir -p branding/acme && cp apps/desktop/icons/128x128.png branding/acme/logo.png
cat > build.config.acme.json <<'JSON'
{ "app": { "name": "Acme", "shortName": "acme", "logo": "branding/acme/logo.png" } }
JSON
BUILD_ENV=acme pnpm tauri:dev
```
Expected: 窗口标题显示 “Acme”、dock 图标为新图、登录/关于页 logo 为新图。验证后还原:

```bash
rm -rf branding/acme build.config.acme.json
git checkout -- apps/desktop/icons packages/app/public apps/desktop/tauri.conf.json
```

---

## Self-Review notes(规划者自检)

- **Spec coverage**:配置 schema(T1)、名称→tauri.conf(T2)、logo→图标生成 + 前端 logo(T3)、Rust 全链路名称:窗口标题/托盘(T4)/OAuth 页(T5)、约定与默认(T6)、副作用文档(T6)、测试(T2/T3 脚本测、T4/T5 Rust 测、T7 汇总)—— 均有对应任务,无遗漏。
- **Placeholder scan**:每个 code step 含完整代码与确切命令,无 TBD/“适当处理”等占位。
- **Type consistency**:脚本导出 `applyNameToTauriConf`/`resolveLogoPlan` 在 T2/T3 一致;Rust `brand_name(Option<&str>) -> String` 在 T4 定义、T4/T5 调用签名一致;`success_html`/`error_html` 在 T5 定义并被同名测试引用。

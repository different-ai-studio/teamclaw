# amuxd 地基 (Block ②) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 amuxd 成为统一安装的地基——随桌面包捆绑 amuxd 二进制、由 amuxd 自己下载/校验/安装 opencode(`amuxd install-opencode` + `amuxd doctor`)、并提供三平台后台服务注册(`amuxd install-service`),为后续安装向导与团队 onboarding 提供 CLI 能力。

**Architecture:** opencode 由 amuxd 拥有(`opencode serve`/`opencode acp` 都由 amuxd spawn)。因此 opencode 的下载逻辑放进 amuxd 的纯 Rust 模块,装到 `~/.amuxd/bin/opencode`,并让 amuxd 优先发现该路径。amuxd 二进制经 Tauri `externalBin` 随包,构建期由 `ensure-amuxd-sidecar.js` 自动编出。服务注册用用户级机制(launchd / systemd user / 计划任务)。

**Tech Stack:** Rust (amuxd: clap, reqwest, sha2, zip, tar, flate2, dirs, serde, tokio, wiremock/tempfile for tests)、Node 构建脚本、Tauri bundle、GitHub Actions。

**本计划分三部分,可分别出 PR:**
- **Part B (Task 1–10)** opencode 安装器 + doctor + 发现优先级 —— 最自洽、最可测,先做。
- **Part C (Task 11–12)** 三平台服务注册 CLI。
- **Part A (Task 13–15)** amuxd 随包捆绑(构建/打包链路)。

每部分都能独立编译通过且 `cargo test -p amuxd` 绿。

---

## File Structure

新增:
- `apps/daemon/opencode.lock.json` — opencode 版本与各 target 资产清单(single source of truth)。
- `apps/daemon/src/opencode_install/mod.rs` — opencode 安装器:lock 解析、目标选择、路径、下载、校验、解压、安装编排、二进制发现、doctor。
- `apps/daemon/src/service/mod.rs` — 服务单元文件生成(纯函数)+ install/uninstall 平台分发。
- `apps/daemon/src/cli/install_opencode.rs` — `amuxd install-opencode` 入口。
- `apps/daemon/src/cli/doctor.rs` — `amuxd doctor` 入口。
- `apps/daemon/src/cli/service.rs` — `amuxd install-service` / `uninstall-service` 入口。
- `scripts/ensure-amuxd-sidecar.js` — 构建期把 amuxd 编进 `apps/desktop/binaries/amuxd-<target>`。

修改:
- `apps/daemon/Cargo.toml` — 加 `zip` / `tar` / `flate2` 依赖。
- `apps/daemon/src/lib.rs`(或 `main.rs` 顶部 `mod` 声明处)— 注册 `opencode_install`、`service` 模块。
- `apps/daemon/src/cli/mod.rs` — `Commands` 加 `InstallOpencode` / `Doctor` / `InstallService` / `UninstallService` 变体 + `pub mod`。
- `apps/daemon/src/main.rs` — 新 match arm。
- `apps/daemon/src/daemon/server.rs:1042-1051` — opencode 二进制发现改用 `opencode_install::resolve_binary`。
- `apps/desktop/tauri.conf.json:81-82` — `externalBin` 加 `binaries/amuxd`。
- `apps/desktop/build.rs` — 加 amuxd sidecar 校验(仿 introspect)。
- `.github/workflows/release.yml` — macOS 与 Windows job 各加 amuxd 编译+copy 步骤。
- 调用 `ensureTeamclawIntrospectSidecar` 的脚本 — 并排调用 `ensureAmuxdSidecar`。

> **模块注册说明**:先确认 amuxd 是否有 `lib.rs`。运行 `ls apps/daemon/src/lib.rs`;若存在,模块 `mod` 声明加在 `lib.rs`;若只有 `main.rs`,加在 `main.rs` 顶部已有的 `mod ...;` 列表旁。本计划下文统称"在 crate 根模块声明处"。

---

## Part B — opencode 安装器 + doctor + 发现

### Task 1: opencode.lock.json + lock 解析 + target 选择

**Files:**
- Create: `apps/daemon/opencode.lock.json`
- Create: `apps/daemon/src/opencode_install/mod.rs`
- Modify: crate 根模块声明处(加 `mod opencode_install;` 或 `pub mod opencode_install;`)

- [ ] **Step 1: 写 lock 文件**

`apps/daemon/opencode.lock.json`(`sha256` 留空字符串表示"暂不校验";Task 5 的下载器只在非空时校验。Windows/linux-arm64 资产名见 §9 风险,先按 GitHub 命名约定填,后续 hardening 再补 sha256):

```json
{
  "version": "v0.0.0-PLACEHOLDER",
  "assets": {
    "aarch64-apple-darwin":      { "name": "opencode-darwin-arm64.zip", "sha256": "" },
    "x86_64-apple-darwin":       { "name": "opencode-darwin-x64.zip",   "sha256": "" },
    "x86_64-unknown-linux-gnu":  { "name": "opencode-linux-x64.tar.gz", "sha256": "" },
    "aarch64-unknown-linux-gnu": { "name": "opencode-linux-arm64.tar.gz","sha256": "" },
    "x86_64-pc-windows-msvc":    { "name": "opencode-windows-x64.zip",  "sha256": "" }
  }
}
```

> `version` 现为占位;落地前用 `gh release view --repo anomalyco/opencode --json tagName -q .tagName` 取实际 tag 替换,并确认上述资产名在该 release 真实存在(Windows/linux-arm64 若缺则删除对应条目,该平台 opencode 步骤降级为"暂不支持")。

- [ ] **Step 2: 写失败测试**

`apps/daemon/src/opencode_install/mod.rs`:

```rust
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_lock_and_selects_asset() {
        let json = r#"{
            "version": "v1.2.3",
            "assets": {
                "aarch64-apple-darwin": { "name": "opencode-darwin-arm64.zip", "sha256": "abc" }
            }
        }"#;
        let lock = OpencodeLock::parse(json).unwrap();
        assert_eq!(lock.version, "v1.2.3");
        let asset = lock.asset_for("aarch64-apple-darwin").unwrap();
        assert_eq!(asset.name, "opencode-darwin-arm64.zip");
        assert_eq!(asset.sha256.as_deref(), Some("abc"));
    }

    #[test]
    fn unknown_target_errors() {
        let lock = OpencodeLock::parse(r#"{"version":"v1","assets":{}}"#).unwrap();
        assert!(lock.asset_for("mips-unknown-linux").is_err());
    }
}
```

- [ ] **Step 3: 运行测试确认失败**

Run: `cargo test -p amuxd opencode_install::tests::parses_lock_and_selects_asset`
Expected: 编译失败 / `cannot find type OpencodeLock`。

- [ ] **Step 4: 写最小实现**

在 `apps/daemon/src/opencode_install/mod.rs` 顶部:

```rust
use serde::Deserialize;
use std::collections::HashMap;

#[derive(Debug, Deserialize)]
pub struct OpencodeLock {
    pub version: String,
    pub assets: HashMap<String, OpencodeAsset>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct OpencodeAsset {
    pub name: String,
    #[serde(default)]
    pub sha256: Option<String>,
}

impl OpencodeLock {
    pub fn parse(s: &str) -> anyhow::Result<Self> {
        Ok(serde_json::from_str(s)?)
    }

    pub fn asset_for(&self, target: &str) -> anyhow::Result<&OpencodeAsset> {
        self.assets
            .get(target)
            .ok_or_else(|| anyhow::anyhow!("no opencode asset for target {target}"))
    }
}

/// Embedded at compile time from apps/daemon/opencode.lock.json
pub const LOCK_JSON: &str = include_str!("../../opencode.lock.json");
```

> `OpencodeAsset` 的 `sha256: ""`(空串)会被解析为 `Some("")`;Task 5 下载器把空串当作"不校验"。

并在 crate 根模块声明处加 `pub mod opencode_install;`。

- [ ] **Step 5: 运行测试确认通过**

Run: `cargo test -p amuxd opencode_install::tests`
Expected: 2 passed。

- [ ] **Step 6: 提交**

```bash
git add apps/daemon/opencode.lock.json apps/daemon/src/opencode_install/mod.rs apps/daemon/src/main.rs apps/daemon/src/lib.rs 2>/dev/null
git commit -m "feat(daemon): opencode.lock.json + lock parser"
```

---

### Task 2: 路径与当前 target 解析

**Files:**
- Modify: `apps/daemon/src/opencode_install/mod.rs`

- [ ] **Step 1: 写失败测试**

追加到 `mod tests`:

```rust
    #[test]
    fn opencode_paths_under_amuxd_bin() {
        let dir = install_dir();
        assert!(dir.ends_with(".amuxd/bin"), "got {dir:?}");
        let bin = opencode_bin_path();
        let expected_name = if cfg!(windows) { "opencode.exe" } else { "opencode" };
        assert_eq!(bin.file_name().unwrap().to_str().unwrap(), expected_name);
        assert!(version_file_path().ends_with(".amuxd/.opencode-version"));
    }

    #[test]
    fn current_target_is_known() {
        // On any supported CI/dev host this must resolve.
        let t = current_target().unwrap();
        assert!(t.contains('-'), "got {t}");
    }
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cargo test -p amuxd opencode_install::tests::opencode_paths_under_amuxd_bin`
Expected: `cannot find function install_dir`。

- [ ] **Step 3: 写最小实现**

追加到 mod 顶部区域:

```rust
use crate::config::DaemonConfig;
use std::path::PathBuf;

pub fn install_dir() -> PathBuf {
    DaemonConfig::config_dir().join("bin")
}

pub fn opencode_bin_path() -> PathBuf {
    let name = if cfg!(windows) { "opencode.exe" } else { "opencode" };
    install_dir().join(name)
}

pub fn version_file_path() -> PathBuf {
    DaemonConfig::config_dir().join(".opencode-version")
}

pub fn current_target() -> anyhow::Result<&'static str> {
    Ok(match (std::env::consts::OS, std::env::consts::ARCH) {
        ("macos", "aarch64") => "aarch64-apple-darwin",
        ("macos", "x86_64") => "x86_64-apple-darwin",
        ("linux", "x86_64") => "x86_64-unknown-linux-gnu",
        ("linux", "aarch64") => "aarch64-unknown-linux-gnu",
        ("windows", "x86_64") => "x86_64-pc-windows-msvc",
        (os, arch) => anyhow::bail!("unsupported platform {os}/{arch}"),
    })
}
```

> `DaemonConfig::config_dir()` 已存在(`daemon_config.rs:291`),返回 `~/.amuxd`。

- [ ] **Step 4: 运行测试确认通过**

Run: `cargo test -p amuxd opencode_install::tests`
Expected: all passed。

- [ ] **Step 5: 提交**

```bash
git add apps/daemon/src/opencode_install/mod.rs
git commit -m "feat(daemon): opencode install paths + target detection"
```

---

### Task 3: sha256 校验

**Files:**
- Modify: `apps/daemon/src/opencode_install/mod.rs`

- [ ] **Step 1: 写失败测试**

追加到 `mod tests`:

```rust
    #[test]
    fn sha256_roundtrip_and_mismatch() {
        let dir = tempfile::tempdir().unwrap();
        let f = dir.path().join("blob");
        std::fs::write(&f, b"hello").unwrap();
        // sha256("hello")
        let expected = "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824";
        assert_eq!(sha256_hex(&f).unwrap(), expected);
        verify_sha256(&f, expected).unwrap();
        assert!(verify_sha256(&f, "deadbeef").is_err());
    }
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cargo test -p amuxd opencode_install::tests::sha256_roundtrip_and_mismatch`
Expected: `cannot find function sha256_hex`。

- [ ] **Step 3: 写最小实现**

```rust
use std::path::Path;

pub fn sha256_hex(path: &Path) -> anyhow::Result<String> {
    use sha2::{Digest, Sha256};
    let mut file = std::fs::File::open(path)?;
    let mut hasher = Sha256::new();
    std::io::copy(&mut file, &mut hasher)?;
    Ok(hex::encode(hasher.finalize()))
}

pub fn verify_sha256(path: &Path, expected: &str) -> anyhow::Result<()> {
    let actual = sha256_hex(path)?;
    if !actual.eq_ignore_ascii_case(expected) {
        anyhow::bail!("sha256 mismatch: expected {expected}, got {actual}");
    }
    Ok(())
}
```

> `sha2 = "0.10"` 和 `hex = "0.4"` 已在 Cargo.toml。

- [ ] **Step 4: 运行测试确认通过**

Run: `cargo test -p amuxd opencode_install::tests::sha256_roundtrip_and_mismatch`
Expected: passed。

- [ ] **Step 5: 提交**

```bash
git add apps/daemon/src/opencode_install/mod.rs
git commit -m "feat(daemon): sha256 verify helper"
```

---

### Task 4: 加归档依赖 + 解压 opencode

**Files:**
- Modify: `apps/daemon/Cargo.toml`
- Modify: `apps/daemon/src/opencode_install/mod.rs`

- [ ] **Step 1: 加依赖**

在 `apps/daemon/Cargo.toml` 的 `[dependencies]` 段加:

```toml
zip = { version = "2", default-features = false, features = ["deflate"] }
tar = "0.4"
flate2 = "1"
```

- [ ] **Step 2: 写失败测试**

追加到 `mod tests`:

```rust
    #[test]
    fn extracts_opencode_from_zip() {
        let dir = tempfile::tempdir().unwrap();
        let archive = dir.path().join("a.zip");
        {
            use std::io::Write;
            let f = std::fs::File::create(&archive).unwrap();
            let mut zw = zip::ZipWriter::new(f);
            zw.start_file("opencode", zip::write::SimpleFileOptions::default()).unwrap();
            zw.write_all(b"BINARY").unwrap();
            zw.finish().unwrap();
        }
        let dest = dir.path().join("out").join("opencode");
        extract_opencode(&archive, &dest).unwrap();
        assert_eq!(std::fs::read(&dest).unwrap(), b"BINARY");
    }

    #[test]
    fn extracts_opencode_from_tar_gz() {
        let dir = tempfile::tempdir().unwrap();
        let archive = dir.path().join("a.tar.gz");
        {
            let f = std::fs::File::create(&archive).unwrap();
            let enc = flate2::write::GzEncoder::new(f, flate2::Compression::default());
            let mut tarw = tar::Builder::new(enc);
            let data = b"TARBIN";
            let mut header = tar::Header::new_gnu();
            header.set_size(data.len() as u64);
            header.set_mode(0o755);
            header.set_cksum();
            tarw.append_data(&mut header, "opencode", &data[..]).unwrap();
            tarw.into_inner().unwrap().finish().unwrap();
        }
        let dest = dir.path().join("opencode");
        extract_opencode(&archive, &dest).unwrap();
        assert_eq!(std::fs::read(&dest).unwrap(), b"TARBIN");
    }
```

- [ ] **Step 3: 运行测试确认失败**

Run: `cargo test -p amuxd opencode_install::tests::extracts_opencode_from_zip`
Expected: `cannot find function extract_opencode`。

- [ ] **Step 4: 写最小实现**

```rust
pub fn extract_opencode(archive: &Path, dest: &Path) -> anyhow::Result<()> {
    let name = archive
        .file_name()
        .and_then(|s| s.to_str())
        .unwrap_or_default();
    if name.ends_with(".zip") {
        extract_zip(archive, dest)
    } else if name.ends_with(".tar.gz") || name.ends_with(".tgz") {
        extract_tar_gz(archive, dest)
    } else {
        anyhow::bail!("unknown archive format: {name}")
    }
}

fn is_opencode_entry(name: &str) -> bool {
    let base = name.rsplit(['/', '\\']).next().unwrap_or("");
    base == "opencode" || base == "opencode.exe"
}

fn write_dest(dest: &Path, reader: &mut impl std::io::Read) -> anyhow::Result<()> {
    if let Some(parent) = dest.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let mut out = std::fs::File::create(dest)?;
    std::io::copy(reader, &mut out)?;
    set_executable(dest)?;
    Ok(())
}

fn extract_zip(archive: &Path, dest: &Path) -> anyhow::Result<()> {
    let file = std::fs::File::open(archive)?;
    let mut zip = zip::ZipArchive::new(file)?;
    for i in 0..zip.len() {
        let mut entry = zip.by_index(i)?;
        if is_opencode_entry(entry.name()) {
            return write_dest(dest, &mut entry);
        }
    }
    anyhow::bail!("opencode binary not found in zip")
}

fn extract_tar_gz(archive: &Path, dest: &Path) -> anyhow::Result<()> {
    let file = std::fs::File::open(archive)?;
    let dec = flate2::read::GzDecoder::new(file);
    let mut tar = tar::Archive::new(dec);
    for entry in tar.entries()? {
        let mut entry = entry?;
        let path = entry.path()?.to_string_lossy().to_string();
        if is_opencode_entry(&path) {
            return write_dest(dest, &mut entry);
        }
    }
    anyhow::bail!("opencode binary not found in tar.gz")
}

fn set_executable(path: &Path) -> anyhow::Result<()> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mut perms = std::fs::metadata(path)?.permissions();
        perms.set_mode(0o755);
        std::fs::set_permissions(path, perms)?;
    }
    let _ = path; // suppress unused on windows
    Ok(())
}
```

- [ ] **Step 5: 运行测试确认通过**

Run: `cargo test -p amuxd opencode_install::tests`
Expected: zip + tar.gz extraction passed。

- [ ] **Step 6: 提交**

```bash
git add apps/daemon/Cargo.toml apps/daemon/src/opencode_install/mod.rs
git commit -m "feat(daemon): extract opencode binary from zip/tar.gz"
```

---

### Task 5: 下载器(官方源 + 镜像 fallback)

**Files:**
- Modify: `apps/daemon/src/opencode_install/mod.rs`

- [ ] **Step 1: 写失败测试(用 wiremock)**

追加到 `mod tests`:

```rust
    #[tokio::test]
    async fn download_to_writes_body() {
        use wiremock::matchers::{method, path};
        use wiremock::{Mock, MockServer, ResponseTemplate};
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/asset.zip"))
            .respond_with(ResponseTemplate::new(200).set_body_bytes(b"PAYLOAD".to_vec()))
            .mount(&server)
            .await;
        let dir = tempfile::tempdir().unwrap();
        let dest = dir.path().join("asset.zip");
        download_to(&format!("{}/asset.zip", server.uri()), &dest)
            .await
            .unwrap();
        assert_eq!(std::fs::read(&dest).unwrap(), b"PAYLOAD");
    }

    #[test]
    fn url_builders() {
        assert_eq!(
            github_url("v1.2.3", "opencode-darwin-arm64.zip"),
            "https://github.com/anomalyco/opencode/releases/download/v1.2.3/opencode-darwin-arm64.zip"
        );
    }
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cargo test -p amuxd opencode_install::tests::download_to_writes_body`
Expected: `cannot find function download_to`。

- [ ] **Step 3: 写最小实现**

```rust
const GITHUB_BASE: &str = "https://github.com/anomalyco/opencode/releases/download";

pub fn github_url(version: &str, asset: &str) -> String {
    format!("{GITHUB_BASE}/{version}/{asset}")
}

/// CN 镜像基址,默认从环境变量 AMUXD_OPENCODE_MIRROR 读(发版时把 opencode 资产镜像到
/// install-mac-cn.sh 用的阿里云 OSS bucket;后续 hardening 可把默认 OSS 基址内置)。
pub fn mirror_url(version: &str, asset: &str) -> Option<String> {
    std::env::var("AMUXD_OPENCODE_MIRROR")
        .ok()
        .filter(|s| !s.is_empty())
        .map(|base| format!("{}/{version}/{asset}", base.trim_end_matches('/')))
}

pub async fn download_to(url: &str, dest: &Path) -> anyhow::Result<()> {
    let resp = reqwest::get(url).await?.error_for_status()?;
    let bytes = resp.bytes().await?;
    if let Some(parent) = dest.parent() {
        std::fs::create_dir_all(parent)?;
    }
    std::fs::write(dest, &bytes)?;
    Ok(())
}

/// 依次尝试给定 URL,第一个成功即返回。
pub async fn download_with_fallback(urls: &[String], dest: &Path) -> anyhow::Result<()> {
    let mut last_err: Option<anyhow::Error> = None;
    for url in urls {
        match download_to(url, dest).await {
            Ok(()) => return Ok(()),
            Err(e) => last_err = Some(e),
        }
    }
    Err(last_err.unwrap_or_else(|| anyhow::anyhow!("no download urls provided")))
}
```

> `reqwest` 已带 `rustls-tls`,无需额外 TLS 配置。

- [ ] **Step 4: 运行测试确认通过**

Run: `cargo test -p amuxd opencode_install::tests`
Expected: download + url_builders passed。

- [ ] **Step 5: 提交**

```bash
git add apps/daemon/src/opencode_install/mod.rs
git commit -m "feat(daemon): opencode downloader with mirror fallback"
```

---

### Task 6: opencode 二进制发现优先级(纯函数)

**Files:**
- Modify: `apps/daemon/src/opencode_install/mod.rs`

- [ ] **Step 1: 写失败测试**

追加到 `mod tests`:

```rust
    #[test]
    fn resolve_binary_precedence() {
        // 显式配置且非共享默认 "claude" → 用配置值
        assert_eq!(resolve_binary_with(Some("/opt/oc"), false), "/opt/oc");
        // 配置是共享默认 "claude" → 忽略,回落
        assert_eq!(resolve_binary_with(Some("claude"), false), "opencode");
        // 无配置且无安装 → "opencode"(PATH)
        assert_eq!(resolve_binary_with(None, false), "opencode");
        // 无配置但已安装到 ~/.amuxd/bin → 用安装路径
        let installed = opencode_bin_path().to_string_lossy().to_string();
        assert_eq!(resolve_binary_with(None, true), installed);
    }
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cargo test -p amuxd opencode_install::tests::resolve_binary_precedence`
Expected: `cannot find function resolve_binary_with`。

- [ ] **Step 3: 写最小实现**

```rust
/// 可测内核:configured=daemon.toml [agents.opencode].binary;installed=安装路径是否存在。
fn resolve_binary_with(configured: Option<&str>, installed: bool) -> String {
    if let Some(b) = configured {
        if !b.is_empty() && b != "claude" {
            return b.to_string();
        }
    }
    if installed {
        return opencode_bin_path().to_string_lossy().to_string();
    }
    "opencode".to_string()
}

/// 生产入口:实际探测安装路径是否存在。
pub fn resolve_binary(configured: Option<&str>) -> String {
    resolve_binary_with(configured, opencode_bin_path().exists())
}
```

> 为什么排除 `"claude"`:`AgentBackendConfig::binary` 的 serde 默认是共享的 `default_claude_binary()`(daemon_config.rs:213),所以 `[agents.opencode]` 存在但没写 binary 时值会是 `"claude"`,必须视为"未指定"。

- [ ] **Step 4: 运行测试确认通过**

Run: `cargo test -p amuxd opencode_install::tests::resolve_binary_precedence`
Expected: passed。

- [ ] **Step 5: 提交**

```bash
git add apps/daemon/src/opencode_install/mod.rs
git commit -m "feat(daemon): opencode binary discovery precedence"
```

---

### Task 7: 接入 server.rs 的 opencode 发现

**Files:**
- Modify: `apps/daemon/src/daemon/server.rs:1042-1051`

- [ ] **Step 1: 替换现有发现逻辑**

把:

```rust
            let opencode_binary = self
                .config
                .agents
                .opencode
                .as_ref()
                .map(|c| c.binary.clone())
                .unwrap_or_else(|| "opencode".to_string());
```

改为:

```rust
            let opencode_binary = crate::opencode_install::resolve_binary(
                self.config.agents.opencode.as_ref().map(|c| c.binary.as_str()),
            );
```

- [ ] **Step 2: 编译检查**

Run: `cargo check -p amuxd`
Expected: 无错误。

- [ ] **Step 3: 跑现有 daemon 测试确认未回归**

Run: `cargo test -p amuxd`
Expected: all passed。

- [ ] **Step 4: 提交**

```bash
git add apps/daemon/src/daemon/server.rs
git commit -m "feat(daemon): prefer ~/.amuxd/bin/opencode in server discovery"
```

---

### Task 8: 安装编排 run_install + 进度输出

**Files:**
- Modify: `apps/daemon/src/opencode_install/mod.rs`

> 编排函数依赖网络/文件系统副作用,采用集成式手测;内部已被 Task 1-6 单测覆盖。

- [ ] **Step 1: 写实现**

```rust
fn progress(event: &str, message: &str) {
    // desktop 向导按行解析 stdout JSON
    println!("{}", serde_json::json!({ "event": event, "message": message }));
}

fn installed_version() -> anyhow::Result<Option<String>> {
    let p = version_file_path();
    if p.exists() {
        Ok(Some(std::fs::read_to_string(&p)?.trim().to_string()))
    } else {
        Ok(None)
    }
}

#[cfg(target_os = "macos")]
fn post_process(path: &Path) {
    let _ = std::process::Command::new("xattr").arg("-cr").arg(path).status();
    let _ = std::process::Command::new("codesign")
        .args(["--force", "--sign", "-"])
        .arg(path)
        .status();
}
#[cfg(not(target_os = "macos"))]
fn post_process(_path: &Path) {}

pub async fn run_install(force: bool) -> anyhow::Result<()> {
    let lock = OpencodeLock::parse(LOCK_JSON)?;
    let target = current_target()?;
    let asset = lock.asset_for(target)?.clone();
    let dest = opencode_bin_path();

    if !force && dest.exists() && installed_version()? == Some(lock.version.clone()) {
        progress("ok", &format!("opencode {} already installed", lock.version));
        return Ok(());
    }

    progress("download", &format!("downloading opencode {}", lock.version));
    let archive = install_dir().join(&asset.name);
    let mut urls = vec![github_url(&lock.version, &asset.name)];
    if let Some(m) = mirror_url(&lock.version, &asset.name) {
        urls.push(m);
    }
    download_with_fallback(&urls, &archive).await?;

    if let Some(sha) = asset.sha256.as_deref() {
        if !sha.is_empty() {
            progress("verify", "verifying checksum");
            verify_sha256(&archive, sha)?;
        }
    }

    progress("extract", "extracting opencode");
    extract_opencode(&archive, &dest)?;
    let _ = std::fs::remove_file(&archive);
    post_process(&dest);
    std::fs::write(version_file_path(), &lock.version)?;

    progress("ok", &format!("opencode {} installed at {}", lock.version, dest.display()));
    Ok(())
}
```

- [ ] **Step 2: 编译检查**

Run: `cargo check -p amuxd`
Expected: 无错误。

- [ ] **Step 3: 提交**

```bash
git add apps/daemon/src/opencode_install/mod.rs
git commit -m "feat(daemon): opencode install orchestration with progress output"
```

---

### Task 9: `amuxd install-opencode` CLI 接线

**Files:**
- Create: `apps/daemon/src/cli/install_opencode.rs`
- Modify: `apps/daemon/src/cli/mod.rs`
- Modify: `apps/daemon/src/main.rs`

- [ ] **Step 1: 新建命令模块**

`apps/daemon/src/cli/install_opencode.rs`:

```rust
pub fn run(force: bool) -> anyhow::Result<()> {
    let rt = tokio::runtime::Runtime::new()?;
    rt.block_on(crate::opencode_install::run_install(force))
}
```

- [ ] **Step 2: 注册子命令**

在 `apps/daemon/src/cli/mod.rs` 顶部 `pub mod` 列表加:

```rust
pub mod install_opencode;
```

在 `Commands` enum 加变体:

```rust
    /// Download and install the opencode binary into ~/.amuxd/bin/opencode.
    InstallOpencode {
        /// Reinstall even if the locked version is already present.
        #[arg(long)]
        force: bool,
    },
```

- [ ] **Step 3: 加 match arm**

在 `apps/daemon/src/main.rs` 的 `match cli.command` 里加:

```rust
        Commands::InstallOpencode { force } => {
            cli::install_opencode::run(force)?;
        }
```

- [ ] **Step 4: 编译 + 手测**

Run: `cargo run -p amuxd -- install-opencode --help`
Expected: 打印该子命令 help,含 `--force`。

> 真实下载手测(需把 lock 的 version 填成实际 tag):`cargo run -p amuxd -- install-opencode` 后 `ls -l ~/.amuxd/bin/opencode && ~/.amuxd/bin/opencode --version`。

- [ ] **Step 5: 提交**

```bash
git add apps/daemon/src/cli/install_opencode.rs apps/daemon/src/cli/mod.rs apps/daemon/src/main.rs
git commit -m "feat(daemon): amuxd install-opencode subcommand"
```

---

### Task 10: `amuxd doctor` 检测 + JSON 报告

**Files:**
- Modify: `apps/daemon/src/opencode_install/mod.rs`
- Create: `apps/daemon/src/cli/doctor.rs`
- Modify: `apps/daemon/src/cli/mod.rs`
- Modify: `apps/daemon/src/main.rs`

- [ ] **Step 1: 写失败测试(报告结构序列化)**

追加到 `opencode_install` 的 `mod tests`:

```rust
    #[test]
    fn doctor_report_serializes() {
        let report = DoctorReport {
            opencode: ComponentStatus { present: true, version: Some("v1".into()), path: Some("/x".into()) },
            git: ComponentStatus { present: false, version: None, path: None },
            amuxd: ComponentStatus { present: true, version: Some("0.1.0".into()), path: Some("/a".into()) },
        };
        let v: serde_json::Value = serde_json::to_value(&report).unwrap();
        assert_eq!(v["opencode"]["present"], serde_json::json!(true));
        assert_eq!(v["git"]["present"], serde_json::json!(false));
        assert_eq!(v["amuxd"]["version"], serde_json::json!("0.1.0"));
    }
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cargo test -p amuxd opencode_install::tests::doctor_report_serializes`
Expected: `cannot find type DoctorReport`。

- [ ] **Step 3: 写最小实现**

在 `apps/daemon/src/opencode_install/mod.rs`(顶部 `use serde::Deserialize;` 改为 `use serde::{Deserialize, Serialize};`):

```rust
#[derive(Debug, Serialize)]
pub struct ComponentStatus {
    pub present: bool,
    pub version: Option<String>,
    pub path: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct DoctorReport {
    pub opencode: ComponentStatus,
    pub git: ComponentStatus,
    pub amuxd: ComponentStatus,
}

fn probe_version(cmd: &str, args: &[&str]) -> Option<String> {
    let out = std::process::Command::new(cmd).args(args).output().ok()?;
    if !out.status.success() {
        return None;
    }
    let s = String::from_utf8_lossy(&out.stdout);
    Some(s.lines().next().unwrap_or("").trim().to_string())
}

pub fn doctor() -> DoctorReport {
    let oc_path = opencode_bin_path();
    let oc_present = oc_path.exists();
    let opencode = ComponentStatus {
        present: oc_present,
        version: installed_version().ok().flatten(),
        path: oc_present.then(|| oc_path.to_string_lossy().to_string()),
    };
    let git = ComponentStatus {
        present: probe_version("git", &["--version"]).is_some(),
        version: probe_version("git", &["--version"]),
        path: None,
    };
    let amuxd_path = DaemonConfig::config_dir().join("bin").join(if cfg!(windows) { "amuxd.exe" } else { "amuxd" });
    let amuxd = ComponentStatus {
        present: amuxd_path.exists(),
        version: Some(env!("CARGO_PKG_VERSION").to_string()),
        path: amuxd_path.exists().then(|| amuxd_path.to_string_lossy().to_string()),
    };
    DoctorReport { opencode, git, amuxd }
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `cargo test -p amuxd opencode_install::tests::doctor_report_serializes`
Expected: passed。

- [ ] **Step 5: 接线 CLI**

`apps/daemon/src/cli/doctor.rs`:

```rust
pub fn run() -> anyhow::Result<()> {
    let report = crate::opencode_install::doctor();
    println!("{}", serde_json::to_string_pretty(&report)?);
    Ok(())
}
```

`apps/daemon/src/cli/mod.rs` 加 `pub mod doctor;` 和 `Commands` 变体:

```rust
    /// Report install status of opencode / git / amuxd as JSON.
    Doctor,
```

`apps/daemon/src/main.rs` 加 arm:

```rust
        Commands::Doctor => {
            cli::doctor::run()?;
        }
```

- [ ] **Step 6: 手测**

Run: `cargo run -p amuxd -- doctor`
Expected: 打印 JSON,含 `opencode`/`git`/`amuxd` 三段。

- [ ] **Step 7: 提交**

```bash
git add apps/daemon/src/opencode_install/mod.rs apps/daemon/src/cli/doctor.rs apps/daemon/src/cli/mod.rs apps/daemon/src/main.rs
git commit -m "feat(daemon): amuxd doctor JSON status report"
```

---

## Part C — 三平台服务注册

### Task 11: 服务单元文件生成(纯函数)

**Files:**
- Create: `apps/daemon/src/service/mod.rs`
- Modify: crate 根模块声明处(加 `pub mod service;`)

- [ ] **Step 1: 写失败测试**

`apps/daemon/src/service/mod.rs`:

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use std::path::Path;

    #[test]
    fn launchd_plist_contains_exec_and_label() {
        let p = launchd_plist(Path::new("/Users/x/.amuxd/bin/amuxd"));
        assert!(p.contains("<string>cc.ucar.amuxd</string>"));
        assert!(p.contains("<string>/Users/x/.amuxd/bin/amuxd</string>"));
        assert!(p.contains("<string>start</string>"));
        assert!(p.contains("<key>RunAtLoad</key>"));
        assert!(p.contains("<key>KeepAlive</key>"));
    }

    #[test]
    fn systemd_unit_contains_execstart_and_restart() {
        let u = systemd_unit(Path::new("/home/x/.amuxd/bin/amuxd"));
        assert!(u.contains("ExecStart=/home/x/.amuxd/bin/amuxd start"));
        assert!(u.contains("Restart=always"));
        assert!(u.contains("[Install]"));
        assert!(u.contains("WantedBy=default.target"));
    }
}
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cargo test -p amuxd service::tests`
Expected: `cannot find function launchd_plist`。

- [ ] **Step 3: 写最小实现**

```rust
use std::path::Path;

pub const LAUNCHD_LABEL: &str = "cc.ucar.amuxd";

pub fn launchd_plist(exe: &Path) -> String {
    format!(
        r#"<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>{label}</string>
  <key>ProgramArguments</key>
  <array>
    <string>{exe}</string>
    <string>start</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
</dict>
</plist>
"#,
        label = LAUNCHD_LABEL,
        exe = exe.display(),
    )
}

pub fn systemd_unit(exe: &Path) -> String {
    format!(
        r#"[Unit]
Description=amuxd (TeamClaw agent daemon)
After=network-online.target

[Service]
ExecStart={exe} start
Restart=always
RestartSec=3

[Install]
WantedBy=default.target
"#,
        exe = exe.display(),
    )
}
```

并在 crate 根模块声明处加 `pub mod service;`。

- [ ] **Step 4: 运行测试确认通过**

Run: `cargo test -p amuxd service::tests`
Expected: 2 passed。

- [ ] **Step 5: 提交**

```bash
git add apps/daemon/src/service/mod.rs apps/daemon/src/main.rs apps/daemon/src/lib.rs 2>/dev/null
git commit -m "feat(daemon): service unit file generators"
```

---

### Task 12: install/uninstall service 分发 + CLI

**Files:**
- Modify: `apps/daemon/src/service/mod.rs`
- Create: `apps/daemon/src/cli/service.rs`
- Modify: `apps/daemon/src/cli/mod.rs`
- Modify: `apps/daemon/src/main.rs`

> 平台分发会 shell-out 到 launchctl/systemctl/schtasks,采用手测;单元文件内容已由 Task 11 覆盖。

- [ ] **Step 1: 写分发实现**

追加到 `apps/daemon/src/service/mod.rs`:

```rust
use crate::config::DaemonConfig;

fn amuxd_exe_path() -> std::path::PathBuf {
    DaemonConfig::config_dir()
        .join("bin")
        .join(if cfg!(windows) { "amuxd.exe" } else { "amuxd" })
}

#[cfg(target_os = "macos")]
pub fn install_service() -> anyhow::Result<()> {
    let exe = amuxd_exe_path();
    let plist_dir = dirs::home_dir()
        .ok_or_else(|| anyhow::anyhow!("no home dir"))?
        .join("Library/LaunchAgents");
    std::fs::create_dir_all(&plist_dir)?;
    let plist_path = plist_dir.join(format!("{LAUNCHD_LABEL}.plist"));
    std::fs::write(&plist_path, launchd_plist(&exe))?;
    let uid = nix_uid();
    let _ = std::process::Command::new("launchctl")
        .args(["bootout", &format!("gui/{uid}/{LAUNCHD_LABEL}")])
        .status();
    let status = std::process::Command::new("launchctl")
        .args(["bootstrap", &format!("gui/{uid}")])
        .arg(&plist_path)
        .status()?;
    anyhow::ensure!(status.success(), "launchctl bootstrap failed");
    Ok(())
}

#[cfg(target_os = "macos")]
pub fn uninstall_service() -> anyhow::Result<()> {
    let uid = nix_uid();
    let _ = std::process::Command::new("launchctl")
        .args(["bootout", &format!("gui/{uid}/{LAUNCHD_LABEL}")])
        .status();
    let plist_path = dirs::home_dir()
        .ok_or_else(|| anyhow::anyhow!("no home dir"))?
        .join("Library/LaunchAgents")
        .join(format!("{LAUNCHD_LABEL}.plist"));
    let _ = std::fs::remove_file(plist_path);
    Ok(())
}

#[cfg(target_os = "macos")]
fn nix_uid() -> u32 {
    // SAFETY: getuid() is always safe.
    unsafe { libc::getuid() }
}

#[cfg(target_os = "linux")]
pub fn install_service() -> anyhow::Result<()> {
    let exe = amuxd_exe_path();
    let unit_dir = dirs::home_dir()
        .ok_or_else(|| anyhow::anyhow!("no home dir"))?
        .join(".config/systemd/user");
    std::fs::create_dir_all(&unit_dir)?;
    std::fs::write(unit_dir.join("amuxd.service"), systemd_unit(&exe))?;
    let _ = std::process::Command::new("loginctl")
        .args(["enable-linger"])
        .status();
    let status = std::process::Command::new("systemctl")
        .args(["--user", "enable", "--now", "amuxd.service"])
        .status()?;
    anyhow::ensure!(status.success(), "systemctl --user enable --now failed");
    Ok(())
}

#[cfg(target_os = "linux")]
pub fn uninstall_service() -> anyhow::Result<()> {
    let _ = std::process::Command::new("systemctl")
        .args(["--user", "disable", "--now", "amuxd.service"])
        .status();
    let unit = dirs::home_dir()
        .ok_or_else(|| anyhow::anyhow!("no home dir"))?
        .join(".config/systemd/user/amuxd.service");
    let _ = std::fs::remove_file(unit);
    Ok(())
}

#[cfg(target_os = "windows")]
pub fn install_service() -> anyhow::Result<()> {
    let exe = amuxd_exe_path();
    let status = std::process::Command::new("schtasks")
        .args([
            "/Create", "/F", "/SC", "ONLOGON", "/TN", "amuxd",
            "/TR",
        ])
        .arg(format!("\"{} start\"", exe.display()))
        .status()?;
    anyhow::ensure!(status.success(), "schtasks /Create failed");
    let _ = std::process::Command::new("schtasks")
        .args(["/Run", "/TN", "amuxd"])
        .status();
    Ok(())
}

#[cfg(target_os = "windows")]
pub fn uninstall_service() -> anyhow::Result<()> {
    let _ = std::process::Command::new("schtasks")
        .args(["/Delete", "/F", "/TN", "amuxd"])
        .status();
    Ok(())
}
```

> macOS `nix_uid()` 用到 `libc::getuid()`。amuxd 是否已依赖 `libc`?Step 2 先检查。

- [ ] **Step 2: 确认 libc 依赖(仅 macOS arm 需要)**

Run: `grep -n '^libc' apps/daemon/Cargo.toml`
- 若无输出,在 `apps/daemon/Cargo.toml` `[dependencies]` 加:`libc = "0.2"`。

- [ ] **Step 3: CLI 接线**

`apps/daemon/src/cli/service.rs`:

```rust
pub fn install() -> anyhow::Result<()> {
    crate::service::install_service()?;
    println!("amuxd service installed and started");
    Ok(())
}

pub fn uninstall() -> anyhow::Result<()> {
    crate::service::uninstall_service()?;
    println!("amuxd service removed");
    Ok(())
}
```

`apps/daemon/src/cli/mod.rs` 加 `pub mod service;` 和变体:

```rust
    /// Register amuxd as a user-level background service (launchd / systemd-user / scheduled task) and start it.
    InstallService,
    /// Stop and remove the amuxd background service.
    UninstallService,
```

`apps/daemon/src/main.rs` 加 arm:

```rust
        Commands::InstallService => {
            cli::service::install()?;
        }
        Commands::UninstallService => {
            cli::service::uninstall()?;
        }
```

- [ ] **Step 4: 编译 + 手测(当前平台)**

Run: `cargo build -p amuxd && ./apps/daemon/../../target/debug/amuxd install-service --help 2>/dev/null || cargo run -p amuxd -- install-service`
Expected(macOS,需先把 amuxd 复制到 `~/.amuxd/bin/amuxd`): 生成 `~/Library/LaunchAgents/cc.ucar.amuxd.plist`,`launchctl list | grep amuxd` 有输出。随后 `cargo run -p amuxd -- uninstall-service` 清除。

> 注意:服务实际启动需要 amuxd 已 onboard(有 backend.toml),否则 `amuxd start` 会因缺团队身份退出——这是预期,真正在 Block ④ onboarding 之后调用。本任务只验证注册/反注册机制。

- [ ] **Step 5: 提交**

```bash
git add apps/daemon/src/service/mod.rs apps/daemon/src/cli/service.rs apps/daemon/src/cli/mod.rs apps/daemon/src/main.rs apps/daemon/Cargo.toml
git commit -m "feat(daemon): amuxd install-service / uninstall-service (launchd/systemd-user/schtasks)"
```

---

## Part A — amuxd 随包捆绑

### Task 13: ensure-amuxd-sidecar.js + 构建链接线

**Files:**
- Create: `scripts/ensure-amuxd-sidecar.js`
- Modify: 调用 `ensureTeamclawIntrospectSidecar` 的脚本

- [ ] **Step 1: 新建构建脚本**

`scripts/ensure-amuxd-sidecar.js`(仿 `ensure-introspect-sidecar.js`,但编 `-p amuxd`):

```js
#!/usr/bin/env node
"use strict";

const { spawnSync } = require("child_process");
const fs = require("fs");
const path = require("path");

/**
 * Build and install amuxd into apps/desktop/binaries/amuxd-<target> if missing.
 * Mirrors ensureTeamclawIntrospectSidecar so tauri bundling finds the sidecar.
 * @param {NodeJS.ProcessEnv} env
 * @param {{ logPrefix?: string }} [opts]
 */
function ensureAmuxdSidecar(env, opts) {
  if (env.CI) {
    return;
  }
  const logPrefix = opts?.logPrefix ?? "[rust-cli]";
  const repoRoot = path.resolve(__dirname, "..");
  const tauriDir = path.join(repoRoot, "apps/desktop");
  const target =
    env.TARGET ||
    (() => {
      const r = spawnSync("rustc", ["-vV"], { encoding: "utf8", env });
      const m = r.stdout && r.stdout.match(/host:\s*(\S+)/);
      return m ? m[1] : "";
    })();
  if (!target) {
    return;
  }
  const binName = process.platform === "win32" ? "amuxd.exe" : "amuxd";
  const destName = process.platform === "win32" ? `amuxd-${target}.exe` : `amuxd-${target}`;
  const dest = path.join(tauriDir, "binaries", destName);
  if (fs.existsSync(dest)) {
    return;
  }
  const manifestPath = path.join(repoRoot, "apps/daemon", "Cargo.toml");
  if (!fs.existsSync(manifestPath)) {
    return;
  }
  console.log(`${logPrefix} Building amuxd sidecar...`);
  const targetDir = env.CARGO_TARGET_DIR || path.join(tauriDir, "target");
  const result = spawnSync(
    "cargo",
    ["build", "--manifest-path", manifestPath, "-p", "amuxd", "--target-dir", targetDir],
    { stdio: "inherit", env },
  );
  if (result.status !== 0) {
    console.error(`${logPrefix} Failed to build amuxd`);
    process.exit(1);
  }
  const built = path.join(targetDir, "debug", binName);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(built, dest);
  console.log(`${logPrefix} Installed ${dest}`);
}

module.exports = { ensureAmuxdSidecar };
```

- [ ] **Step 2: 找到 introspect 的调用点并并排调用 amuxd**

Run: `grep -rn "ensureTeamclawIntrospectSidecar" scripts/`
对每个 `require(... ensure-introspect-sidecar ...)` + 调用的地方,加上对应的 amuxd 调用。典型改法:在 `const { ensureTeamclawIntrospectSidecar } = require("./ensure-introspect-sidecar");` 后加:

```js
const { ensureAmuxdSidecar } = require("./ensure-amuxd-sidecar");
```

并在调用 `ensureTeamclawIntrospectSidecar(env, ...)` 处的下一行加:

```js
ensureAmuxdSidecar(env, { logPrefix });
```

(用与该处相同的 `env` / `logPrefix` 变量。)

- [ ] **Step 3: 验证生成**

Run: `rm -f apps/desktop/binaries/amuxd-* && node -e "require('./scripts/ensure-amuxd-sidecar').ensureAmuxdSidecar(process.env)"`
Expected: 编译 amuxd 并生成 `apps/desktop/binaries/amuxd-<host-target>`;`ls apps/desktop/binaries/amuxd-*` 有文件。

- [ ] **Step 4: 提交**

```bash
git add scripts/ensure-amuxd-sidecar.js scripts/*.js
git commit -m "build: ensure-amuxd-sidecar.js + wire into rust build"
```

---

### Task 14: tauri externalBin + build.rs amuxd 校验

**Files:**
- Modify: `apps/desktop/tauri.conf.json:81-83`
- Modify: `apps/desktop/build.rs`

- [ ] **Step 1: externalBin 加 amuxd**

把:

```json
    "externalBin": [
      "binaries/teamclaw-introspect"
    ],
```

改为:

```json
    "externalBin": [
      "binaries/teamclaw-introspect",
      "binaries/amuxd"
    ],
```

- [ ] **Step 2: build.rs 加 amuxd 校验(仿 introspect 的 panic 风格)**

在 `apps/desktop/build.rs` 的 introspect 校验块之后(`println!("cargo:rerun-if-changed={}", introspect_bin);` 之前或之后、`tauri_build::build()` 之前)加:

```rust
    // amuxd sidecar is bundled (built by scripts/ensure-amuxd-sidecar.js before cargo).
    let amuxd_bin = format!("binaries/amuxd-{}", target_triple);
    let amuxd_bin_exe = format!("{}.exe", amuxd_bin);
    let amuxd_exists = std::path::Path::new(&amuxd_bin).exists()
        || (target_triple.contains("windows") && std::path::Path::new(&amuxd_bin_exe).exists());
    if !amuxd_exists && !in_ci {
        panic!(
            "\n\namuxd sidecar binary not found: {}\nBuild it with: node -e \"require('./scripts/ensure-amuxd-sidecar').ensureAmuxdSidecar(process.env)\"\n\n",
            amuxd_bin
        );
    }
    println!("cargo:rerun-if-changed={}", amuxd_bin);
```

- [ ] **Step 3: 编译桌面确认通过**

Run: `pnpm rust:check`
Expected: 编译通过(本机已由 Task 13 生成 amuxd sidecar)。若 panic 提示缺失,先跑 Task 13 Step 3 再试。

- [ ] **Step 4: 提交**

```bash
git add apps/desktop/tauri.conf.json apps/desktop/build.rs
git commit -m "build(desktop): bundle amuxd as tauri sidecar"
```

---

### Task 15: release.yml 编译 amuxd

**Files:**
- Modify: `.github/workflows/release.yml`(macOS 并行块 ~line 105-114;Windows job ~line 359-364)

- [ ] **Step 1: macOS 并行块加 amuxd 编译**

在 introspect 的后台编译块(`> /tmp/introspect.log 2>&1 &` / `PID_INTROSPECT=$!`)之后,加:

```bash
          # 2b) Build amuxd sidecar (background)
          (
            set -e
            echo "Building amuxd for ${{ matrix.target }}..."
            cargo build --release --locked --manifest-path apps/daemon/Cargo.toml -p amuxd --target ${{ matrix.target }}
            cp apps/desktop/target/${{ matrix.target }}/release/amuxd apps/desktop/binaries/amuxd-${{ matrix.target }}
            chmod +x apps/desktop/binaries/amuxd-${{ matrix.target }}
            echo "amuxd ready"
          ) > /tmp/amuxd.log 2>&1 &
          PID_AMUXD=$!
```

并在后续 `wait $PID_INTROSPECT`(或等待汇总处)旁加 `wait $PID_AMUXD`,确保该步随其它后台任务一同 `wait` 并检查退出码(参照该 step 现有的 wait/错误处理写法)。

> `--manifest-path apps/daemon/Cargo.toml` + 共享 workspace target,产物在 `apps/desktop/target/<target>/release/amuxd`(与 introspect 同 target-dir)。若 workspace target 路径不同,以 introspect 那行的 `apps/desktop/target/...` 为准对齐。

- [ ] **Step 2: Windows job 加 amuxd 编译**

在 Windows job 的 introspect 步骤之后加:

```yaml
      - name: Build amuxd sidecar
        shell: bash
        run: |
          cargo build --release --locked --manifest-path apps/daemon/Cargo.toml -p amuxd
          cp apps/desktop/target/release/amuxd.exe apps/desktop/binaries/amuxd-x86_64-pc-windows-msvc.exe
          echo "amuxd ready"
```

- [ ] **Step 3: 本地静态校验 YAML**

Run: `python3 -c "import yaml,sys; yaml.safe_load(open('.github/workflows/release.yml')); print('yaml ok')"`
Expected: `yaml ok`。

- [ ] **Step 4: 提交**

```bash
git add .github/workflows/release.yml
git commit -m "ci(release): build and bundle amuxd sidecar (macOS + windows)"
```

---

## Self-Review

**Spec coverage(对照 design §2/§4/§5/§6.1/§8 中属于 Block ② 的条目):**
- amuxd 捆绑(externalBin + ensure-amuxd-sidecar.js + release.yml + build.rs)→ Task 13/14/15 ✅
- opencode 安装器归 amuxd、装到 `~/.amuxd/bin/opencode`、CN 镜像、版本锁、sha256 → Task 1–9 ✅
- amuxd 优先发现 `~/.amuxd/bin/opencode` → Task 6/7 ✅
- `amuxd doctor` → Task 10 ✅
- `amuxd install-service`(launchd/systemd-user/schtasks)→ Task 11/12 ✅
- 清理 desktop dead-code `opencode.rs` → **不在本计划**(归 Block ① 删除/标记,或单独清理 PR);此处不动避免牵连。
- `amuxd init` / 服务启动时机 → 属 Block ④,本计划只提供 `install-service` 能力,不在 onboarding 流程接线。

**Placeholder 扫描:** `opencode.lock.json` 的 `version` 与 `sha256` 是**数据占位**,已在 Task 1 用明确命令(`gh release view ...`)说明落地前如何填实;下载器对空 `sha256` 显式跳过校验(Task 5/8),非代码占位。其余步骤均含完整代码/命令。

**类型一致性:** `OpencodeLock` / `OpencodeAsset` / `ComponentStatus` / `DoctorReport` / `resolve_binary` / `run_install` / `doctor` / `install_service` / `uninstall_service` / `launchd_plist` / `systemd_unit` 在定义与调用处签名一致;`serde` 顶部 import 在 Task 10 由 `Deserialize` 扩成 `{Deserialize, Serialize}`。

**风险提示(承自 design §9):** opencode 是否发布 Windows / linux-arm64 资产未证实——Task 1 Step 1 要求落地时核对,缺则删条目并降级该平台;OSS 镜像默认基址用 `AMUXD_OPENCODE_MIRROR` 环境变量,内置默认值留作 hardening 跟进。

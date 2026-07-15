# 定制 opencode 打包到 OSS + onboarding 识别定制版 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把定制 opencode fork 镜像到阿里云 OSS 方便国内下载，并让 onboarding 识别到的是带 TeamClaw 标记的定制 opencode 而非公版。

**Architecture:** fork 构建产物的 `--version` 带 `-teamclaw` 后缀作为身份标记；amuxd 的 `doctor()` 在版本比较之外增加 marker 检查；新增 GitHub Action 把 fork release 资产镜像到 OSS `opencode/stable/`；build.config 与默认下载源全部指向 fork（OSS / fork GitHub），不再回落公版。

**Tech Stack:** Rust (amuxd `opencode_install` 模块)、GitHub Actions + Python `oss2`、bash 发布脚本、JSON build.config。

## Global Constraints

- fork 仓库：`different-ai-studio/opencode`，分支 `dev`，当前版本 `v1.17.7`。
- marker 字符串：`teamclaw`，以 semver pre-release 后缀形式出现：`<ver>-teamclaw`。
- 平台资产名（5 个，固定）：`opencode-darwin-arm64.zip`、`opencode-darwin-x64.zip`、`opencode-windows-x64.zip`、`opencode-linux-x64.tar.gz`、`opencode-linux-arm64.tar.gz`。
- OSS 稳定基址：`https://teamclaw.ucar.cc/opencode/stable`（覆盖式，不随版本改）。
- OSS 上传复用现有 secrets：`OSS_ACCESS_KEY_ID`、`OSS_ACCESS_KEY_SECRET`、`OSS_ENDPOINT`、`OSS_BUCKET`（见 `.github/workflows/release-beta.yml`）。
- fork 默认 GitHub 源：`https://github.com/different-ai-studio/opencode/releases/latest/download`。
- Rust 检查命令：`pnpm rust:check`（或 `cargo test -p amuxd opencode_install`）。
- 绝不回落到公版 `sst/opencode`。

---

### Task 1: opencode.lock.json 加 marker 字段 + Rust 解析/检测逻辑

**Files:**
- Modify: `apps/daemon/opencode.lock.json`
- Modify: `apps/daemon/src/opencode_install/mod.rs`
- Test: `apps/daemon/src/opencode_install/mod.rs`（`#[cfg(test)] mod tests`）

**Interfaces:**
- Consumes: 现有 `OpencodeLock`、`required_version()`、`version_ge()`、`detect_opencode()`、`OpencodeStatus`、`doctor()`。
- Produces:
  - `OpencodeLock { version: String, marker: Option<String> }`
  - `pub fn required_marker() -> Option<String>`（返回 trim 后非空的 marker）
  - `OpencodeStatus` 新增字段 `pub is_fork: bool`
  - `doctor()` 中 `satisfied = version_ge(v, &want) && is_fork`

- [ ] **Step 1: 更新 lock 文件**

`apps/daemon/opencode.lock.json` 改为：

```json
{
  "version": "v1.17.7",
  "marker": "teamclaw"
}
```

- [ ] **Step 2: 写失败测试**

在 `apps/daemon/src/opencode_install/mod.rs` 的 `mod tests` 内追加：

```rust
    #[test]
    fn lock_parses_marker_optional() {
        let with = OpencodeLock::parse(r#"{"version":"v1.17.7","marker":"teamclaw"}"#).unwrap();
        assert_eq!(with.marker.as_deref(), Some("teamclaw"));
        let without = OpencodeLock::parse(r#"{"version":"v1.15.13"}"#).unwrap();
        assert_eq!(without.marker, None);
    }

    #[test]
    fn required_marker_reads_embedded_lock() {
        assert_eq!(required_marker().as_deref(), Some("teamclaw"));
    }

    #[test]
    fn doctor_is_fork_requires_marker() {
        // fork version (carries marker) is a fork; public version is not.
        assert!(version_has_marker("1.17.7-teamclaw", Some("teamclaw")));
        assert!(!version_has_marker("1.17.7", Some("teamclaw")));
        // no required marker -> always treated as fork (back-compat)
        assert!(version_has_marker("1.17.7", None));
    }
```

- [ ] **Step 3: 运行测试确认失败**

Run: `cargo test -p amuxd opencode_install 2>&1 | tail -20`
Expected: 编译失败 / FAIL —— `marker` 字段不存在、`required_marker`、`version_has_marker` 未定义。

- [ ] **Step 4: 实现**

在 `mod.rs` 中：

修改 `OpencodeLock`：

```rust
#[derive(Debug, Deserialize)]
pub struct OpencodeLock {
    pub version: String,
    #[serde(default)]
    pub marker: Option<String>,
}
```

新增（放在 `required_version()` 之后）：

```rust
/// The fork identity marker this build requires in `opencode --version`
/// (e.g. "teamclaw"). None means any opencode is acceptable (back-compat).
pub fn required_marker() -> Option<String> {
    OpencodeLock::parse(LOCK_JSON)
        .ok()
        .and_then(|l| l.marker)
        .map(|m| m.trim().to_string())
        .filter(|m| !m.is_empty())
}

/// True if `version` carries the required fork marker. No required marker -> true.
pub fn version_has_marker(version: &str, marker: Option<&str>) -> bool {
    match marker {
        Some(m) => version.contains(m),
        None => true,
    }
}
```

在 `OpencodeStatus` 增加字段：

```rust
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OpencodeStatus {
    pub present: bool,
    pub version: Option<String>,
    pub path: Option<String>,
    pub required_version: String,
    pub is_fork: bool,
    pub satisfied: bool,
}
```

修改 `doctor()` 中构造 opencode 状态的部分：

```rust
    let want = required_version();
    let marker = required_marker();
    let detected = detect_opencode();
    let (present, version, path) = match &detected {
        Some((p, v)) => (true, Some(v.clone()), Some(p.clone())),
        None => (false, None, None),
    };
    let is_fork = version
        .as_deref()
        .map(|v| version_has_marker(v, marker.as_deref()))
        .unwrap_or(false);
    let satisfied = version
        .as_deref()
        .map(|v| version_ge(v, &want))
        .unwrap_or(false)
        && is_fork;
    let opencode = OpencodeStatus {
        present,
        version,
        path,
        required_version: want,
        is_fork,
        satisfied,
    };
```

并更新 `doctor_report_serializes` 测试里构造的 `OpencodeStatus { ... }` 字面量，补 `is_fork: true,`。

- [ ] **Step 5: 运行测试确认通过**

Run: `cargo test -p amuxd opencode_install 2>&1 | tail -20`
Expected: PASS（含新测试 `lock_parses_marker_optional`、`required_marker_reads_embedded_lock`、`doctor_is_fork_requires_marker`）。

- [ ] **Step 6: 提交**

```bash
git add apps/daemon/opencode.lock.json apps/daemon/src/opencode_install/mod.rs
git commit -m "feat(daemon): require teamclaw fork marker in opencode doctor"
```

---

### Task 2: 默认下载源改为 fork（杜绝回落公版）+ 更新 download_url 测试

**Files:**
- Modify: `apps/daemon/src/opencode_install/mod.rs:112`（`DEFAULT_DOWNLOAD_BASE`）
- Test: `apps/daemon/src/opencode_install/mod.rs`（`download_url_honors_base_override`）

**Interfaces:**
- Consumes: `download_url(base_override, asset)`、`DEFAULT_DOWNLOAD_BASE`。
- Produces: 无新符号，仅常量值变化。

- [ ] **Step 1: 改测试预期为失败状态**

把 `download_url_honors_base_override` 中默认 base 的断言改为 fork：

```rust
    #[test]
    fn download_url_honors_base_override() {
        assert_eq!(
            download_url(None, "opencode-windows-x64.zip"),
            "https://github.com/different-ai-studio/opencode/releases/latest/download/opencode-windows-x64.zip"
        );
        assert_eq!(
            download_url(Some("https://mirror.example/oc/"), "opencode-darwin-arm64.zip"),
            "https://mirror.example/oc/opencode-darwin-arm64.zip"
        );
    }
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cargo test -p amuxd opencode_install::tests::download_url_honors_base_override 2>&1 | tail -15`
Expected: FAIL —— 实际仍是 `sst/opencode`。

- [ ] **Step 3: 实现**

修改常量（约 `mod.rs:111-112`）：

```rust
/// Default upstream for opencode release assets — the TeamClaw fork (NOT public
/// sst/opencode). Overseas fallback when no OSS mirror base is configured.
const DEFAULT_DOWNLOAD_BASE: &str =
    "https://github.com/different-ai-studio/opencode/releases/latest/download";
```

- [ ] **Step 4: 运行测试确认通过**

Run: `cargo test -p amuxd opencode_install 2>&1 | tail -15`
Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add apps/daemon/src/opencode_install/mod.rs
git commit -m "feat(daemon): default opencode download to teamclaw fork, never public"
```

---

### Task 3: build.config 指向 OSS stable 镜像

**Files:**
- Modify: `build.config.production.json`
- Modify: `build.config.dev.json`
- Modify: `build.config.example.json`

**Interfaces:**
- Consumes: `build-config.ts` 的 `opencode.downloadBase`（已有，见 `packages/app/src/lib/build-config.ts:63-68`、`packages/app/src/stores/setup.ts:116`）。
- Produces: 无代码符号；运行期 `OPENCODE_DOWNLOAD_BASE` 取值变化。

- [ ] **Step 1: 改三个 build.config**

在每个文件的 `opencode` 段把 `downloadBase` 设为 OSS stable。`build.config.production.json` 与 `build.config.dev.json`：

```json
  "opencode": {
    "downloadBase": "https://teamclaw.ucar.cc/opencode/stable"
  }
```

`build.config.example.json`（示例值同样指向 OSS stable，保持文档一致）：

```json
  "opencode": {
    "downloadBase": "https://teamclaw.ucar.cc/opencode/stable"
  }
```

注意：若某文件原本没有 `opencode` 段，按其 JSON 结构插入并保持逗号正确；`build.config.example.json` 已有该段（第 32-33 行），就地改值即可。

- [ ] **Step 2: 校验 JSON 合法**

Run: `for f in build.config.production.json build.config.dev.json build.config.example.json; do node -e "JSON.parse(require('fs').readFileSync('$f','utf8'));console.log('$f ok')"; done`
Expected: 三行均 `... ok`，无解析错误。

- [ ] **Step 3: 提交**

```bash
git add build.config.production.json build.config.dev.json build.config.example.json
git commit -m "feat: point opencode downloadBase to OSS fork mirror"
```

---

### Task 4: 发布脚本注入 teamclaw marker

**Files:**
- Modify: `scripts/release-opencode-fork.sh`

**Interfaces:**
- Consumes: 现有变量 `VERSION`、`TAG`、`bun run script/build.ts --single`、`gh workflow run release-cli`。
- Produces: 构建出的二进制 `--version` 含 `-teamclaw`。

- [ ] **Step 1: 本地构建路径注入 marker**

把构建那一行（约第 93 行）从：

```bash
(cd "$WORKDIR/repo/packages/opencode" && OPENCODE_VERSION="$VERSION" bun run script/build.ts --single)
```

改为：

```bash
MARKER_VERSION="${VERSION#v}-teamclaw"
(cd "$WORKDIR/repo/packages/opencode" && OPENCODE_VERSION="$MARKER_VERSION" bun run script/build.ts --single)
```

- [ ] **Step 2: --trigger-ci 路径同样带 marker**

把 dispatch 那一行（约第 63 行）从：

```bash
  gh workflow run release-cli --repo "$REPO" -f "version=${VERSION#v}" -f "tag=${tag}"
```

改为：

```bash
  gh workflow run release-cli --repo "$REPO" -f "version=${VERSION#v}-teamclaw" -f "tag=${tag}"
```

- [ ] **Step 3: 静态校验脚本**

Run: `bash -n scripts/release-opencode-fork.sh && echo "syntax ok"`
Expected: `syntax ok`。

- [ ] **Step 4: 提交**

```bash
git add scripts/release-opencode-fork.sh
git commit -m "feat(scripts): stamp -teamclaw marker into opencode fork builds"
```

---

### Task 5: 新增 OSS 镜像 GitHub Action

**Files:**
- Create: `.github/workflows/mirror-opencode-oss.yml`

**Interfaces:**
- Consumes: secrets `OSS_ACCESS_KEY_ID`、`OSS_ACCESS_KEY_SECRET`、`OSS_ENDPOINT`、`OSS_BUCKET`、`GITHUB_TOKEN`；fork release 资产。
- Produces: OSS 对象 `opencode/stable/<asset>`（5 个平台），可经 `https://teamclaw.ucar.cc/opencode/stable/<asset>` 下载。

- [ ] **Step 1: 创建 workflow 文件**

`.github/workflows/mirror-opencode-oss.yml`：

```yaml
name: Mirror opencode fork to OSS

on:
  workflow_dispatch:
    inputs:
      tag:
        description: "fork release tag to mirror (e.g. v1.17.7)"
        required: true
        default: "v1.17.7"

jobs:
  mirror:
    runs-on: ubuntu-latest
    env:
      FORK_REPO: different-ai-studio/opencode
      OSS_PREFIX: opencode/stable
    steps:
      - name: Download fork release assets
        env:
          GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}
          TAG: ${{ github.event.inputs.tag }}
        run: |
          set -euo pipefail
          mkdir -p assets
          for a in \
            opencode-darwin-arm64.zip \
            opencode-darwin-x64.zip \
            opencode-windows-x64.zip \
            opencode-linux-x64.tar.gz \
            opencode-linux-arm64.tar.gz; do
            if gh release download "$TAG" --repo "$FORK_REPO" --pattern "$a" --dir assets --clobber; then
              echo "✓ got $a"
            else
              echo "::warning::asset $a not found in $FORK_REPO@$TAG — skipping"
            fi
          done
          echo "--- downloaded ---"
          ls -la assets || true
          if [ -z "$(ls -A assets 2>/dev/null)" ]; then
            echo "::error::no assets downloaded — aborting"
            exit 1
          fi

      - name: Upload assets to OSS (opencode/stable, overwrite)
        env:
          OSS_ACCESS_KEY_ID: ${{ secrets.OSS_ACCESS_KEY_ID }}
          OSS_ACCESS_KEY_SECRET: ${{ secrets.OSS_ACCESS_KEY_SECRET }}
          OSS_ENDPOINT: ${{ secrets.OSS_ENDPOINT }}
          OSS_BUCKET: ${{ secrets.OSS_BUCKET }}
        run: |
          set -euo pipefail
          if [ -z "${OSS_ACCESS_KEY_ID:-}" ]; then
            echo "::error::OSS secrets not configured"
            exit 1
          fi
          python3 -m pip install oss2 --quiet --break-system-packages 2>/dev/null || pip3 install oss2 --quiet --break-system-packages
          python3 - <<'EOF'
          import oss2, os, glob
          auth = oss2.Auth(os.environ['OSS_ACCESS_KEY_ID'], os.environ['OSS_ACCESS_KEY_SECRET'])
          endpoint = os.environ['OSS_ENDPOINT']
          if not endpoint.startswith('http'):
              endpoint = 'https://' + endpoint
          bucket = oss2.Bucket(auth, endpoint, os.environ['OSS_BUCKET'])
          prefix = os.environ['OSS_PREFIX']
          files = sorted(glob.glob('assets/*'))
          if not files:
              raise SystemExit('no assets to upload')
          for local in files:
              name = os.path.basename(local)
              key = f'{prefix}/{name}'
              print(f'Uploading {name} -> oss://{os.environ["OSS_BUCKET"]}/{key}')
              bucket.put_object_from_file(key, local)
              print(f'✅ {key}')
          EOF
```

- [ ] **Step 2: 校验 YAML 合法**

Run: `python3 -c "import yaml,sys; yaml.safe_load(open('.github/workflows/mirror-opencode-oss.yml')); print('yaml ok')"`
Expected: `yaml ok`。（若环境无 pyyaml：`python3 -m pip install pyyaml --quiet --break-system-packages` 后重试。）

- [ ] **Step 3: 提交**

```bash
git add .github/workflows/mirror-opencode-oss.yml
git commit -m "ci: mirror opencode fork release assets to OSS stable"
```

---

### Task 6: 全量校验 + 文档更新

**Files:**
- Modify: `apps/daemon/src/opencode_install/mod.rs`（仅在 `OPENCODE_DOWNLOAD_BASE` 注释处提及 OSS stable，可选润色）
- 无新建文件

**Interfaces:**
- Consumes: 前序所有改动。
- Produces: 通过的完整 Rust 测试套件。

- [ ] **Step 1: 运行 amuxd 全量相关测试**

Run: `cargo test -p amuxd opencode_install 2>&1 | tail -25`
Expected: 全部 PASS，无编译告警阻断。

- [ ] **Step 2: Rust 编译检查**

Run: `pnpm rust:check 2>&1 | tail -15`
Expected: 编译通过（无 error）。

- [ ] **Step 3: 复核 spec 覆盖**

人工对照 `docs/specs/2026-06-29-opencode-oss-mirror-fork-onboarding-design.md` 的「受影响文件」表，确认每项都已在 Task 1–5 落地：lock marker(✓T1)、doctor satisfied(✓T1)、DEFAULT_DOWNLOAD_BASE(✓T2)、build.config×3(✓T3)、release 脚本 marker(✓T4)、mirror workflow(✓T5)。

- [ ] **Step 4: 提交（若有润色改动）**

```bash
git add -A
git commit -m "chore: finalize opencode OSS mirror + fork marker wiring"
```

---

## 待发布后运维（非本计划代码任务，记录备忘）

- fork 需产出 5 平台资产（当前仅 darwin-arm64）；其余依赖 fork `release-cli` 多平台 CI。
- 升级 opencode 时同步更新 `opencode.lock.json` 的 `version`，并重跑 `mirror-opencode-oss.yml`。
- 首跑 workflow 后验证 `https://teamclaw.ucar.cc/opencode/stable/opencode-darwin-arm64.zip` 可下载。
- 生产 `BUILD_CONFIG_PRODUCTION` secret 若覆盖 build.config，需确保其 `opencode.downloadBase` 同样指向 OSS stable。

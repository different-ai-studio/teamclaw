# 定制 opencode 打包到 OSS + onboarding 识别定制版 — 设计

日期：2026-06-29
状态：已确认设计，待写实现计划

## 背景与问题

TeamClaw 使用一个**定制的 opencode fork**（`different-ai-studio/opencode`，
当前 `v1.17.7`）作为 ACP runtime。当前实现有两个缺口：

1. **生产装的是公版，不是 fork。** `build.config.production.json` 的
   `opencode.downloadBase` 为空，且 `apps/daemon/src/opencode_install/mod.rs` 的
   `DEFAULT_DOWNLOAD_BASE` 指向公版 `https://github.com/sst/opencode/releases/latest/download`。
   所以默认 onboarding 会安装公版 opencode。
2. **onboarding 无法区分 fork 与公版。** `doctor()` 只比较版本号
   (`version_ge`)；公版只要版本号够新就会被判定 `satisfied`。
3. **国内下载慢/受限。** fork 资产只在 GitHub Releases 上，国内用户拉取困难，需要
   镜像到阿里云 OSS（已有 `teamclaw.ucar.cc` 这套 OSS 分发用于 DMG）。

目标：把定制 opencode 镜像到 OSS 方便国内下载；onboarding 必须检测到的是**我们的
定制 opencode**，而不是公版。

## 已确认的设计决策

- **识别方式**：fork 构建时让 `opencode --version` 携带 TeamClaw 标记（semver
  pre-release 后缀，如 `1.17.7-teamclaw`）。
- **marker 位置**：写在 `apps/daemon/opencode.lock.json`。
- **OSS 上传**：新增 GitHub Action 自动镜像。
- **OSS 路径**：稳定覆盖路径 `opencode/stable/`（每次发版覆盖；`build.config` 固定不
  改；`opencode.lock.json` 的版本作为下限）。
- **平台范围**：darwin arm64、darwin x64、windows x64、linux x64、linux arm64。

## 方案细节

### 1. fork 身份标记（区分定制 vs 公版）

fork 的 `opencode --version` 输出携带 `-teamclaw` 后缀，例如 `1.17.7-teamclaw`。
我们同时掌控 fork 仓库与发布脚本，故在 fork 构建时设置
`OPENCODE_VERSION=<ver>-teamclaw`（build.ts 会把它嵌入二进制）。无需改 fork 业务
代码，只改发布管线传入的版本字符串。

对现有 Rust 逻辑的影响：

- `parse_semver` 已在 `-` 处截断，故 `version_ge("1.17.7-teamclaw", "1.17.7")` 仍为
  真，版本比较不受影响。
- `opencode_version_of` 返回匹配到的整 token，`-teamclaw` 后缀得以保留，供检查使用。

`opencode.lock.json` 增加 `marker` 字段：

```json
{
  "version": "v1.17.7",
  "marker": "teamclaw"
}
```

`opencode_install/mod.rs` 改动：

- `OpencodeLock` 增加 `pub marker: Option<String>`（向后兼容；缺省视为不要求
  marker，便于测试/旧 lock）。
- 新增 `required_marker() -> Option<String>`。
- `OpencodeStatus` 增加 `pub is_fork: bool`。
- `doctor()`：`is_fork = required_marker().map_or(true, |m| version.contains(&m))`；
  `satisfied = version_ge(..) && is_fork`。
- 含义：装了公版（无 marker）→ `is_fork=false` → `satisfied=false` →
  onboarding 提示安装/替换 fork。

desktop 侧无需改动：`setup_list_requirements` 已读取 `opencode.satisfied`，UI 据
`present` 显示 安装/升级。

### 2. OSS 镜像 GitHub Action

新增 `.github/workflows/mirror-opencode-oss.yml`：

- 触发：`workflow_dispatch`（输入 `tag`，默认读取某处的当前 fork tag）；可选
  `repository_dispatch`（由 fork 发版后回调触发）。
- 步骤：
  1. 用 `gh release download <tag> --repo different-ai-studio/opencode` 拉取 5 个资产：
     `opencode-darwin-arm64.zip`、`opencode-darwin-x64.zip`、
     `opencode-windows-x64.zip`、`opencode-linux-x64.tar.gz`、
     `opencode-linux-arm64.tar.gz`。
  2. 用 ossutil（复用 secrets `OSS_ENDPOINT`、`OSS_BUCKET` 及阿里云
     AK/SK secrets，与 `release.yml` 一致）上传到 `oss://<bucket>/opencode/stable/`，
     逐个覆盖。
- 结果：稳定基址 `https://teamclaw.ucar.cc/opencode/stable/opencode-<os>-<arch>.<ext>`。
- 缺失资产处理：若某平台资产在该 fork release 不存在，记录告警但不让整个 job 失败
  （当前 fork 仅 darwin-arm64 已发布，其余待 fork 多平台 CI 产出）。

### 3. 把生产/开发指向 fork 镜像

- `build.config.production.json` 与 `build.config.dev.json`：设置
  `opencode.downloadBase = "https://teamclaw.ucar.cc/opencode/stable"`。amuxd 据此
  direct-download `${base}/opencode-<os>-<arch>.<ext>`。
- `opencode_install/mod.rs`：把 `DEFAULT_DOWNLOAD_BASE` 从 `sst/opencode`（公版）改为
  fork 的 `https://github.com/different-ai-studio/opencode/releases/latest/download`。
  这样即使没有 build.config 也不会回落到公版——海外用户从 GitHub 拿 fork，国内用户
  从 OSS 拿 fork。

### 4. fork 发布脚本带 marker

`scripts/release-opencode-fork.sh`：构建时把版本改成带 marker，即
`OPENCODE_VERSION="${VERSION}-teamclaw"` 传给 `bun run script/build.ts --single`，
使产出的二进制 `--version` 含 `-teamclaw`。`--trigger-ci` 路径同样需把 marker 传给
fork 的 `release-cli` workflow（通过 `-f version=${VERSION}-teamclaw` 或等价输入）。

## 受影响文件

| 文件 | 改动 |
|------|------|
| `apps/daemon/opencode.lock.json` | 加 `marker` 字段 |
| `apps/daemon/src/opencode_install/mod.rs` | `OpencodeLock.marker`、`required_marker()`、`OpencodeStatus.is_fork`、`doctor()` satisfied 逻辑、`DEFAULT_DOWNLOAD_BASE` 改 fork、相关单测 |
| `build.config.production.json` | `opencode.downloadBase` 指向 OSS stable |
| `build.config.dev.json` | 同上 |
| `build.config.example.json` | 注释/示例更新（可选） |
| `.github/workflows/mirror-opencode-oss.yml` | 新增 OSS 镜像 workflow |
| `scripts/release-opencode-fork.sh` | 版本带 `-teamclaw` marker |
| `scripts/install-opencode-fork.sh` | 可选：默认 base 与 marker 对齐（保持一致性） |

## 测试

- Rust 单测（`opencode_install` 模块）：
  - `OpencodeLock::parse` 解析含/不含 `marker` 的 lock。
  - `doctor`/satisfied 逻辑：有 marker 的版本 `is_fork=true`；公版版本
    `is_fork=false` 且 `satisfied=false`；版本偏低同样 `satisfied=false`。
  - `download_url` 默认 base 现指向 fork。
- workflow：本地 dry-run（`act` 或手工核对 ossutil 命令）；首次手动 `workflow_dispatch`
  跑通一次确认 OSS 路径可访问。
- 端到端（手动，需真实环境）：在生产 build 下 onboarding 安装 opencode，确认拉取的是
  OSS fork 且 `--version` 含 `-teamclaw`，doctor `satisfied=true`。

## 非目标 / YAGNI

- 不做 fork 仓库内部业务代码改动（只改其发布产物的版本字符串）。
- 不做版本号自动同步（lock 版本与 fork 版本仍手动对齐）。
- 不引入新 OSS secrets（复用 `release.yml` 既有的 OSS 凭证）。
- 不做 OSS `latest.txt` 之类的版本指针（stable 覆盖路径已足够）。

## 待发布后运维事项

- fork 需产出 5 平台资产（当前仅 darwin-arm64）；其余平台依赖 fork 的
  `release-cli` 多平台 CI 跑通。
- 确认 `opencode.lock.json` 的 `version` 与 fork 实际发布 tag 对齐，并在每次升级时
  一并更新。
- 首次跑 `mirror-opencode-oss.yml` 后，验证
  `https://teamclaw.ucar.cc/opencode/stable/opencode-darwin-arm64.zip` 可下载。

# P1：Workspace 元数据按 brand 对齐（完整方案）

> 状态：**已落地**（2026-08）。依赖 P0（`TEAMCLU_BRAND_SHORT_NAME` /
> `AMUXD_HOME`）。目标：daemon / `teamclu-runtime-env` 与 Desktop 使用同一套
> workspace 元数据目录约定，消灭「Desktop 写 `.{brand}`、daemon 读 `.teamclu`」。

相关：

- [`multi-brand-local-daemon.md`](./multi-brand-local-daemon.md)（P0 amuxd 状态目录）
- [`personal-env-and-runtime-env.md`](./personal-env-and-runtime-env.md)

---

## 1. 问题

| 角色 | Workspace 元数据约定 |
|---|---|
| Desktop（compile-time） | Official：`.teamclu/teamclu.json`；白标：`.{brand}/{brand}.json` |
| Daemon / runtime-env（今日） | **大量写死** `.teamclu/...` |

结果：

- 干净白标 workspace（只有 `.copilot361`）→ skills / roles / 配置热更新 / allowlist / sync state **可能失效**
- 老 workspace 双目录并存 → 「看起来能跑」，但设置页改 `copilot361.json`、daemon watch `teamclu.json` → **热更新错位**
- Desktop 与 daemon 长期两套真相，运维/排障成本高

个人变量注入（blob）**不依赖**本 P1；本 P1 管的是 **workspace 内元数据与 daemon 本地旁路文件**。

---

## 2. 目标 / 非目标

### 要

1. Daemon 与 Desktop **同一 brand 解析规则** 决定 meta dir / config 文件名  
2. **读**：优先 brand 规范路径；必要时兼容旧 `.teamclu`（迁移窗口）  
3. **写**：只写 brand 规范路径，不再往幽灵 `.teamclu` 写新数据（白标）  
4. Skills / roles / refresh watch / allowlist / active-session / opencode.runtime / sync state / team 配置读取 全部走 helper  
5. Official 路径行为与今日 **二进制兼容**（仍是 `.teamclu`）

### 不要

- 改 `teamclu-team` 链接名（跨 brand 固定，已拍板）  
- 改云端 schema / team 共享目录结构  
- 自动删除用户旧 `.teamclu`（最多提示 / 可选 one-shot 复制）  
- Desktop 大范围改名（Desktop 已正确；本 P1 以 daemon + runtime-env 为主）  
- 远程 daemon 特殊逻辑（跟本机 brand env 同一套即可）

---

## 3. 规范（与 Desktop `build.rs` 对齐）

在 `teamclu-runtime-env::storage_namespace`（或并列模块）提供：

```text
workspace_meta_dir_name(brand) -> ".teamclu" | ".{brand}"
workspace_config_file_name(brand) -> "teamclu.json" | "{brand}.json"

workspace_meta_dir(workspace, brand) -> PathBuf
workspace_config_path(workspace, brand) -> PathBuf
workspace_rel(brand, rel) -> "{meta}/{rel}"   # e.g. skills, allowlist.json
```

Brand 来源（与 P0 一致）：

1. 显式参数（测试 / catalog 已有 `brand_short_name`）  
2. 否则 `brand_short_name_from_env()`（`TEAMCLU_BRAND_SHORT_NAME`）

**已 brand-aware、保持不动：**

- `env_catalog::workspace_config_path`（已按 brand 分流）— 改为调用统一 helper，去掉重复逻辑  
- Desktop `TEAMCLU_DIR` / `CONFIG_FILE_NAME`（compile-time）— 规则必须与 helper **字符串级一致**（加单测锁死）

**跨 brand 固定（不改）：**

| 名称 | 值 |
|---|---|
| Team link / 全局 sync 目录 | `teamclu-team` |
| Team `_secrets` 子目录名 | `_secrets` |
| Workspace 根上的 `opencode.json` | 仍在 workspace 根（非 meta dir） |

---

## 4. 文件清单与归属

凡今日写在 `{workspace}/.teamclu/` 下、应由 **当前 brand meta dir** 承载的：

| 相对路径 | 用途 | 今日硬编码位置（代表） |
|---|---|---|
| `{config}.json` | workspace / team / envVars 索引 | `sync/git.rs`, `team_provider.rs`, `refresh_watch` |
| `skills/` | inherent + 用户 skills | `roles_skills.rs`, `supervisor.rs` |
| `roles/` | roles + roles/skills | `roles_skills.rs` |
| `allowlist.json` | 权限永久记住 | `workspace_control.rs` |
| `active-session-id` | MCP session 戳记 | `active_session.rs` |
| `opencode.runtime.json` | 运行时 secrets 物化 | `opencode_config.rs` `RUNTIME_OVERLAY_REL` |
| `sync/state.json` | OSS sync 本地状态 | `sync/oss/state.rs` |
| 渠道旁路（若存在） | 如 email.db 等 | `channels/manager` 注释路径 |

**不迁入 meta dir：**

- `opencode.json`（workspace 根，OpenCode 约定）  
- `teamclu-team/`（团队共享，固定名）  
- `~/.{brand}/secrets`（P0/personal，home 级）  
- `~/.amuxd[-brand]/`（P0，home 级）

---

## 5. 读写策略（兼容迁移）

### 5.1 读（resolve）

对任意逻辑文件 `rel`（如 `skills`、`allowlist.json`）：

```text
canonical = workspace / meta(brand) / rel
legacy    = workspace / ".teamclu" / rel     # 仅当 brand 非 official

if canonical.exists() → use canonical
else if legacy.exists() → use legacy (read-only 兼容)
else → use canonical（后续写入会创建）
```

Official brand：`canonical == legacy`，无双路径。

### 5.2 写（mutate）

**永远写 canonical**（白标写 `.{brand}/...`，不再新建 `.teamclu/...`）。

可选（本阶段默认 **不做**，保持轻）：

- 首次写前若仅有 legacy：把该文件/目录 **copy** 到 canonical 再写（one-shot per path）  
- 或仅文档提示用户手动合并

默认行为：读 legacy 仍可用；新写入落到 brand 目录 → 双份短暂并存，可接受。

### 5.3 热更新 watch

`refresh_watch` 必须同时监听（白标）：

- `.{brand}/{brand}.json`  
- `.{brand}/skills`  
- （兼容期）`.teamclu/teamclu.json` + `.teamclu/skills`

Official 只听 `.teamclu/...`。

---

## 6. 实现分桶（建议 PR 切分）

### PR-A：Helper + 锁规则（无行为变化于 official）

1. `storage_namespace` 增加 `workspace_meta_dir_name` / `workspace_config_file_name` / path builders  
2. 单测：与 Desktop 规则表交叉锁定  

```text
teamclu     → .teamclu / teamclu.json
teamcludev  → .teamclu / teamclu.json
copilot361   → .copilot361 / copilot361.json
```

3. `env_catalog::workspace_config_path` 改为调用 helper  

### PR-B：runtime-env 写路径品牌化（daemon 间接受益）

| 模块 | 改动 |
|---|---|
| `active_session.rs` | meta dir from brand |
| `opencode_config.rs` | `runtime_overlay_path(workspace, brand)` |
| `team_provider.rs` | `resolve_shared_dir_name` 读 brand config（带 legacy fallback） |
| `mcp_resolve` / `team_provider_sync` | overlay 路径跟 brand |

### PR-C：daemon 功能路径

| 模块 | 改动 |
|---|---|
| `config/roles_skills.rs` | `ROLE_ROOT` / skills 根 → helper；扫描兼容 legacy |
| `runtime/supervisor.rs` | inherent skills 目录 |
| `runtime/refresh_watch.rs` | watch 目标品牌化 + legacy |
| `config/workspace_control.rs` | allowlist 路径 |
| `sync/git.rs` | team 配置读取 |
| `sync/oss/state.rs` | `TEAMCLU_DIR` 常量 → brand resolve |
| `channels/*` | 若有 workspace 旁路 DB，一并替换 |

### PR-D：测试与文档

- 白标 fixture：仅 `.copilot361/` 无 `.teamclu` → skills 可见、allowlist 可写、watch 触发  
- Official 回归：路径仍为 `.teamclu`  
- 双目录兼容：仅 legacy 有 skills 时仍能列出  
- 更新 `multi-brand-local-daemon.md` / personal-env 文档交叉链接  

**建议落地顺序：** A → B → C → D；每步可单独合入。

---

## 7. API 形状（建议）

```rust
// teamclu-runtime-env
pub fn workspace_meta_dir_name(brand: &str) -> String;
pub fn workspace_config_file_name(brand: &str) -> String;

pub fn workspace_meta_dir(workspace: &Path, brand: &str) -> PathBuf;
pub fn workspace_config_path(workspace: &Path, brand: &str) -> PathBuf;

/// Resolve a file/dir under workspace meta with optional legacy fallback.
pub fn resolve_workspace_meta_path(
    workspace: &Path,
    brand: &str,
    rel: impl AsRef<Path>,
) -> PathBuf; // returns path to use for read (may be legacy if only legacy exists)

pub fn workspace_meta_write_path(
    workspace: &Path,
    brand: &str,
    rel: impl AsRef<Path>,
) -> PathBuf; // always canonical
```

Daemon 侧薄封装（避免到处传 brand 字符串）：

```rust
fn brand() -> String { teamclu_runtime_env::brand_short_name_from_env() }
fn meta_skills(ws: &Path) -> PathBuf {
    resolve_workspace_meta_path(ws, &brand(), "skills")
}
```

---

## 8. 迁移对现有用户的影响

| 用户 | 影响 |
|---|---|
| Official | 无（路径不变） |
| 白标 + 双目录（今日多数） | 读仍能命中 `.teamclu`；新写入进 `.{brand}`；长期可手动删旧目录 |
| 白标 + 仅 `.{brand}` | **修复** skills/配置（今日是坏的） |
| 白标 + 仅 `.teamclu`（极少） | 读兼容；写开始创建 `.{brand}` |

**不做**自动 `rm -rf .teamclu`。可选后续工具：`amuxd doctor` 报告「legacy meta present」。

---

## 9. 验收清单

1. `BUILD_ENV`/brand=`copilot361` 的 daemon：  
   - 干净 workspace 只有 `.copilot361` → inherent skills 写入 `.copilot361/skills`  
   - Desktop 改 `copilot361.json` → refresh_watch 触发  
2. Official：所有路径仍在 `.teamclu`，现有 e2e/单测绿  
3. 兼容：workspace 仅有 `.teamclu/skills`、无 `.copilot361/skills` → roles_skills 仍列出  
4. `opencode.runtime.json` 出现在 brand meta dir，不在错误旁路  
5. allowlist 写入 brand meta；重启后仍生效  
6. P0 行为不回归：`~/.amuxd-<brand>` + personal secrets brand 路径  

---

## 10. 风险与缓解

| 风险 | 缓解 |
|---|---|
| 漏改一处硬编码 | grep CI gate：`apps/daemon` 禁止新增字面量 `".teamclu"`（测试 fixture 除外 allowlist） |
| 双目录内容分叉 | 读优先 canonical；文档说明「以 Desktop brand 目录为准」 |
| Overlay 路径变了导致旧 runtime 找不到 | 读 fallback legacy；新 spawn 写 canonical |
| Helper 与 Desktop compile-time 漂移 | 共享规则单测 + 可选从同一常量生成（长期） |

---

## 11. 工作量粗估

| 桶 | 量级 |
|---|---|
| PR-A helper + 锁测 | 小（0.5–1d） |
| PR-B runtime-env | 中（1–2d） |
| PR-C daemon | 中大（2–3d） |
| PR-D 测试/文档/grep gate | 小（0.5–1d） |

合计约 **1 周以内**（含复习与回归），可按 PR 切开降低风险。

---

## 12. 一句话

**P1 = 用与 Desktop 相同的 brand→meta-dir 规则，让 daemon 的读（含 `.teamclu` 兼容）和写（只写 `.{brand}`）对齐；不动 team 链接名与 personal/amuxd home（P0 已覆盖）。**

---

## 13. 落地摘要（实现）

| 层 | 关键 API / 改动 |
|---|---|
| `teamclu-runtime-env::storage_namespace` | `workspace_meta_dir_name` / `workspace_config_*` / `resolve_*` / `write_path` / `meta_read_roots` |
| runtime-env 消费者 | `env_catalog`, `active_session`, `opencode_config` overlay, `team_provider`, `mcp_resolve` |
| daemon | `roles_skills`, `supervisor`, `refresh_watch`, `workspace_control` allowlist, `sync/git`, `sync/oss/state` |
| 防回归 | `apps/daemon/src/workspace_meta_gate.rs` — 禁止 production 硬编码 `".teamclu"` 路径字面量 |

测试覆盖：官方路径、白标仅 `.{brand}`、白标 legacy fallback、watch 双路径、overlay/allowlist/sync state 写路径。

# amuxd 家目录布局 v2（规范）

> 状态：规范性文档。本文的目录树**就是验收标准**，与
> `teamclu_runtime_env::storage_namespace::ROOT_ALLOWLIST` 逐项对齐；两者不一致
> 时以本文为准，并在同一个 PR 里改回一致。
>
> 决策依据见 [ADR-0006](../adr/0006-daemon-state-is-team-scoped.md)。
> 面向用户的说明见 [`../amuxd-home-directory.md`](../amuxd-home-directory.md)。

---

## 1. 两条不可违反的规则

**规则一：谁拥有目录，谁负责写。**

| 目录 | 拥有者 | 另一方 |
|---|---|---|
| `~/.amuxd*` | daemon | 桌面端只读（发现端口 / token / 诊断），**不写** |
| `~/.{brand}/` | 桌面端 | daemon 只读（个人密钥），**不写** |
| `<workspace>/` | 双方 | 各写各的文件，见 §5 |

**规则二：`~/.amuxd` 根目录只允许出现这六项。**

```text
daemon.toml  device-id  teams/  run/  logs/  cache/
```

新增任何东西之前，先回答一个问题：**换一个团队，这个值该不该跟着变？**
该变 → `teams/<id>/state/`；不该变且是缓存 → `cache/`；不该变且是进程运行时 →
`run/`；都不是 → 它多半不属于这里。

---

## 2. 目录树

```text
~/.amuxd/                              # 官方（shortName = teamclu）
                                       # 白标为 ~/.amuxd-<brand>
                                       # $AMUXD_HOME 覆盖两者
│
├── daemon.toml                        # 机器级配置 + 活跃团队指针（§3.1）
├── device-id                          # daemon 安装 id，仅用于版本上报（§3.2）
│
├── run/                               # 进程运行时，随进程生灭，可安全删除
│   ├── amuxd.pid
│   ├── amuxd.lock
│   ├── amuxd.sock                     # 仅 unix；Windows 用命名管道，不落盘
│   ├── amuxd.http.port
│   ├── amuxd.http.token               # 0600
│   └── opencode.serve.pgid
│
├── logs/
│   └── amuxd.log                      # 轮换：单文件上限 + 保留份数（§3.3）
│
├── cache/                             # 机器级缓存，删了只影响性能
│   ├── model-catalog.toml             # 键控：backend → worktree
│   ├── model-mru.toml                 # 键控：backend
│   └── pi/                            # pi runtime 扩展
│
└── teams/
    ├── _unclaimed/                    # 未 onboard 时的落盘位置（§4.1）
    └── <team_id>/
        │
        ├── shared/                    # ★ 同步引擎唯一扫描根
        │   └── teamclu-team/          # workspace 软链指向这里
        │       └── knowledge/
        │
        ├── workspace/                 # 无 workspace 时的默认可写 worktree
        │
        └── state/                     # daemon 私有，永不同步
            ├── backend.toml           # 云端凭证（§4.2）
            ├── team.toml              # 团队级配置（§4.3）
            ├── secret.key             # 本团队主密钥，0600
            ├── secrets.enc            # 团队密钥 + channels 凭证
            ├── cloud-token            # 0600，注入为 TC_ACCESS_TOKEN_FILE
            ├── members.toml           # 成员 / pending invite 缓存
            ├── runtimes.toml          # 本机 runtime 索引（§4.4）
            ├── cursor-permissions.json
            ├── sync.json              # 同步水位
            ├── history/<actor_id>.bin
            ├── mcp-configs/<hash>.json
            ├── attachments/<session_id>/
            ├── pi-sessions/<session_id>/
            ├── apps/<app_id>/
            └── sessions/
                ├── index.toml         # 会话元数据（§4.4）
                └── <session_id>/
                    └── messages.toml
```

`shared/` 是同步引擎**唯一**被授权扫描的路径。这条收紧之后，"往团队目录里加一个
文件会不会被推上云"的答案恒为"不会"——而不是旧布局里那句"取决于你加在哪一层"。

---

## 3. 根目录各项

### 3.1 `daemon.toml`

只装**机器级**配置，外加一个指针。它不再包含 `team_id`、`[actor].id`、
`[channels]`、`[team_share]`。

```toml
active_team = "<team_id>"          # 缺失 = 未 onboard，落盘走 teams/_unclaimed/

[actor]
name = "Mac-mini-8"                # 运维可改的显示名；id 在 backend.toml

[mqtt]
broker_url = ""                    # 空 = 从 /v1/config/bootstrap 解析

[http]
bind = "127.0.0.1:0"
allowed_origins = [...]
# …其余 HTTP 参数

[agents]
auto_discover = true               # 探测本机二进制并写回本文件

[agents.opencode]                  # 本机绝对路径 —— 机器级
binary = "/Users/x/.opencode/bin/opencode"
default_flags = []
```

`[agents]` 的另外两部分**不在这里**：`local_agent` 属于团队（`team.toml`），
`api_key` 属于个人（`~/.{brand}/secrets`）。

### 3.2 `device-id`

daemon 这一次安装的 id，**只用于 daemon 自己的版本上报**。它与前端的
`teamclu.client.install-id` 是两个东西，不可互换——后者同时是匿名 / 访客团队的
身份键，而 AuthGate 跑在 daemon 就绪之前、且在非 Tauri 构建里根本没有 daemon。

路径解析必须走 `teamclu_runtime_env::amuxd_home_from_env()`，不得硬编码。

### 3.3 `logs/`

单文件 `amuxd.log`，带轮换（上限与保留份数在 `daemon.toml` 的 `[log]` 段，
默认 32 MB × 3）。旧布局的 `amuxd.out.log` / `amuxd.err.log` /
`amuxd.managed.log` 三份并存且永不截断，实测单机 116 MB。

---

## 4. `teams/<team_id>/`

### 4.1 `_unclaimed`

未 onboard 的 daemon 是受支持的常驻状态（`DeferredBackend::unclaimed()`），
而嵌入式 `/v1/ui` chat 可以在没有 workspace 的情况下建会话。这些落盘写进
`teams/_unclaimed/`；claim 成功时**整目录 rename** 成 `teams/<team_id>/`。

于是代码里永远只有一条路径："当前团队目录"，不需要在每个写入点判空。
`_unclaimed` 是保留字，team_id 是 UUID，前缀下划线保证不撞。

### 4.2 `state/backend.toml`

```toml
kind = "cloud_api"

[cloud_api]
url = "https://api.teamclu-dev.ucar.cc"
refresh_token = "…"
team_id = "<team_id>"
actor_id = "<actor_id>"
```

`team_id` 和 `actor_id` **只此一份**。旧布局里它们同时存在于 `daemon.toml`，
onboarding 一次写两份、事后无人校验——那个问题是靠消灭副本解决的，不是靠加
一致性检查。

`actor.id` 即 `actor_id`：Cloud API 的 access-token hook 按
`amux/{team}/{actor}/…` 发 ACL，填错值会让 EMQX 直接拒绝 CONNECT。

单独成文件的理由是**写入频率**：token 轮换要频繁原子写回，不能和用户手改的配置
同处一文件——否则一次轮换失败会带走用户的 channel 配置。

### 4.3 `state/team.toml`

```toml
local_agent = "opencode"           # 团队规定用哪个 runtime

[team_share]
auto_sync = true

[channels.wecom]                   # 只有结构，没有凭证
enabled = true
[[channels.wecom.bots]]
bot_id = "…"
workspace_id = "…"
agent_type = "opencode"
system_prompt = "…"
```

**凭证字段一律不在这里**：`bot_token`、`secret`、`app_secret`、
`encoding_aes_key` 全部存进 `secrets.enc`。分界是"改 system_prompt 不该需要
解密，而任何凭证不该明文落盘"。

`config/edit.rs::is_secret_key` 的 `channels.*` 分支随之失效（`http/config.rs`
对这些键的打码不再有对象），但该函数本身要保留——`mqtt.password` 仍在
`daemon.toml` 里。

### 4.4 两个会话存储

它们是两样东西，不合并，但必须**不同名**：

| 文件 | 原名 | 装什么 | 写入特征 |
|---|---|---|---|
| `state/runtimes.toml` | `sessions.toml` | runtime_id ↔ acp_session_id ↔ 云端 session_id ↔ worktree | 热路径，高频 |
| `state/sessions/index.toml` | `teamclu/sessions.toml` | 会话标题、参与者 | 冷数据 |

改名不是审美：`config::SessionStore` 记的**是 runtime 不是 session**，而两个同名
的 `sessions.toml` 是旧布局里最容易认错的一组东西。

---

## 5. 不在 `~/.amuxd` 里的东西

| 路径 | 拥有者 | 内容 |
|---|---|---|
| `~/.{brand}/secrets/` | 桌面端 | `master.key`、`personal-secrets.json.enc`、`meta.json` |
| `~/.{brand}/local-cache.db` | 桌面端 | 会话 / 消息缓存 |
| `~/.{brand}/telemetry-consent.json` | 桌面端 | 遥测授权 |
| `<workspace>/.{brand}/` | 双方 | `{brand}.json`、`knowledge.db`、`bm25_index/`、`stats.json`、`cron-jobs.json`、`allowlist.json` |
| `<workspace>/teamclu-team` | daemon | 软链 → `~/.amuxd/teams/<id>/shared/teamclu-team`，**链接名跨品牌固定** |
| `~/.opencode/bin/opencode` | opencode 安装器 | 官方二进制 |

`~/.{brand}` 的目录名由**唯一**的品牌判据推导（§6），桌面端与 daemon 必须调用
同一个 helper。旧代码里 `local-cache.db` 和 `cached-path.txt` 用工作区常量
`TEAMCLU_DIR` 拼家目录名、`telemetry-consent.json` 直接硬编码 `.teamclu`——
两者都不再允许。

---

## 6. 品牌判据

**只有 `teamclu` 是官方**，其余一律白标。

```text
is_official(short_name) := short_name == "teamclu"

~/.amuxd            ← 官方          ~/.amuxd-<brand>   ← 白标
~/.teamclu/         ← 官方          ~/.{brand}/        ← 白标
<ws>/.teamclu/      ← 官方          <ws>/.{brand}/     ← 白标
teamclu.json        ← 官方          {brand}.json       ← 白标
```

解析顺序不变：`$AMUXD_HOME` → `$TEAMCLU_BRAND_SHORT_NAME` → 上表。

这个判据**只允许有一个实现**，在 `teamclu-runtime-env::storage_namespace`。
`apps/desktop/build.rs` 把它作为 build-dependency 直接调用；
`packages/app/src/lib/build-config.ts` 因为是另一条工具链，镜像那一个字符串，
由 `__tests__/brand-parity.test.ts` 读 Rust 源码守住镜像——为一个字符串搭 codegen
不划算，但一个"Rust 侧一动就红"的测试是值得的。旧代码三处实现两处互相矛盾，
betly 的家目录因此被劈成两半。

`LEGACY_BRAND_STORAGE_DIR` 一类常量保留，但降级为**清理清单的输入**（§7），不再
参与品牌解析。

> **需要在本仓库之外完成的一步：** betly 的 `shortName` 目前是 `teamclaw`，
> 它与 `LEGACY_BRAND_WORKSPACE_META_DIR`（`.teamclaw`）同名，而官方构建会主动
> 消费那个目录。必须在私有 branding 仓把 betly 的 `shortName` 改成 `betly`，
> 本仓库的改动无法代劳。在那一步完成之前，betly 构建的家目录会是
> `~/.teamclaw` / `~/.amuxd-teamclaw`，与官方的 legacy 清理清单重叠。

---

## 7. 硬切与清理

新版**不迁移任何旧数据**。首次启动时，daemon 在拿到单实例锁之后、
`DaemonConfig::load` 之前，按固定清单删除旧路径：

```text
~/.amuxd/{backend.toml, daemon.toml, members.toml, sessions.toml,
          workspaces.toml, secret.key, supabase.toml}
~/.amuxd/{team-secrets, history, mcp-configs, attachments, teamclu,
          pi-sessions, bin, apps}/
~/.amuxd/teams/<id>/{teamclu-team, cloud, sync}/        # 旧的团队内布局
~/.amuxd/*.log  ~/.amuxd/*.bak.*  ~/.amuxd/*.pid …      # 根目录残留
<config_dir>/amux/                                       # 旧家目录
```

删 `backend.toml` 和 `daemon.toml` 不是为了整洁：前者的 `refresh_token` 是一把
仍能换取 access token 的活钥匙，后者的 `[channels].bot_token` 与
`agents.cursor.api_key` 是明文凭证。硬切后没有代码会再读它们，留在盘上是纯风险。

用户侧的实际代价：**重新 onboard 一次**，外加丢掉本机 runtime 索引（云端
`agent_runtimes` 仍是主 resume 路径）。官方用户的 `~/.teamclu` 路径不变，个人
密钥原地存活。betly 用户因短名改为 `betly`，需重录个人 API key——发版说明须
明说。

同批删除的迁移代码：`DaemonConfig::migrate_legacy_file()` /
`legacy_config_dir()`、`provider_config` 的 `supabase.toml` 迁移、
`secret_store::legacy_secrets_path()` 与其自愈搬运器、
`workspace_link::migrate_legacy_dir`、桌面端 `commands/storage_migration.rs`、
前端 `lib/storage-migration.ts`。

---

## 8. 护栏

| 护栏 | 形式 | 抓什么 |
|---|---|---|
| 根目录白名单 | 单元测试：跑完 bootstrap + 清理后断言根目录条目 ⊆ `ROOT_ALLOWLIST` | 新功能往根目录偷加文件 |
| 字面量棘轮 | `storage_lint`：扫全仓 `.rs` / `.ts` / `.tsx`，禁止引号后紧跟 `.amuxd` / `.teamclu` / `.teamclaw` | 自己拼路径绕过解析器（`apps_data_root()` 连 `config_dir()` 都没调） |

棘轮**双向失败**：新增一个手写家目录会红，而清理干净后忘记把文件从 `DEBT` 里删掉
**同样会红**。没有人被迫修剪的 allow 列表很快就不再有意义。

首版 `DEBT` 含 **46 个文件**（PR ② 清掉 `build.rs` 后），此后只许缩短。`OWNERS`（2 个：
`storage_namespace.rs` 与棘轮自身）按设计豁免，不参与增减。

这两条测试跑在 `cargo test -p teamclu-runtime-env`——该 crate 的测试**此前从未
进过 CI**，本 PR 一并加进 `ci.yml` 的 `daemon-linux` job。

---

## 9. 相关代码入口

| 主题 | 位置 |
|---|---|
| 路径解析（唯一实现） | `crates/teamclu-runtime-env/src/storage_namespace.rs` |
| 根目录白名单常量 `ROOT_ALLOWLIST` | 同上 |
| 字面量棘轮 | `crates/teamclu-runtime-env/src/storage_lint.rs` |
| 启动清理 | `apps/daemon/src/config/layout.rs`（PR ④） |
| 团队目录布局 | `apps/daemon/src/config/global_team_store.rs` |
| 团队密钥 | `apps/daemon/src/sync/secret_store.rs` |
| workspace 软链 | `apps/daemon/src/config/workspace_link.rs` |
| 桌面端 amuxd 发现 | `apps/desktop/src/commands/mod.rs` |

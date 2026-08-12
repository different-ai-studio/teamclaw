---
status: accepted
---

# daemon 本机状态按团队下沉，且不做迁移

`~/.amuxd` 根目录收敛为六项：`daemon.toml`、`device-id`、`teams/`、`run/`、
`logs/`、`cache/`。凡是**换一个团队就该换一份**的状态——云端凭证、会话索引、
事件历史、团队密钥、channels 配置——全部下沉到 `teams/<team_id>/`。

品牌 officiality 收敛为单一判据：**只有 `teamclu` 是官方**，其余（含
`teamcludev`、`teamclaw`、`teamclawdev`）一律白标。

新版**不迁移任何旧数据**：首次启动按已知清单删除旧路径，用户重新 onboard。

完整目标布局与验收标准见
[`../architecture/amuxd-home-layout-v2.md`](../architecture/amuxd-home-layout-v2.md)。

## 为什么

**根目录是个垃圾场，因为没有任何规则说什么能放进去。** 排查时数出 5 个存储根、
约 60 个文件/目录、约 40 个 localStorage 键，其中 14 处是同一份事实被两个主人
各存一遍：`team_id` 和 `actor_id` 同时在 `daemon.toml` 与 `backend.toml`；两个
schema 不同的 `sessions.toml`（根一个、`teamclu/` 一个）；两把互不知情的加密主
密钥；三处 `is_official_brand` 实现有两处互相矛盾。这些不是各自独立的疏忽——
`apps_data_root()` 自己拼 `$HOME/.amuxd/apps`、`device_id.rs` 硬编码
`~/.amuxd`、`local-cache.db` 拿工作区常量 `TEAMCLU_DIR` 当家目录名，说明"新东西
往哪写"从来没有答案，于是每次都现编一个。

**下沉的判据是"换团队该不该跟着变"，不是"看起来像不像团队的东西"。** 按这一条
过一遍，`channels` 是团队的（`channels/manager.rs` 每个 handler 都在接
`self.team_id`，运行时早就是团队内的，只是存储在机器级），`team_share.auto_sync`
是团队的，而 `[agents]` 是三样东西穿一件衣服：`binary` 路径是机器的、
`local_agent` 是团队的、`api_key` 是个人的，必须拆开。

**officiality 只认 `teamclu`，是因为多一个名字就多一处碰撞。** `teamclaw` 既是
betly 的现役短名，又是 `LEGACY_BRAND_WORKSPACE_META_DIR`——而官方构建会在**每次
打开 workspace 时**把 `.teamclaw/` 合并进 `.teamclu/`（无 marker，永远重跑）。
两个品牌在同一个目录名上互相寄生，且无法从目录内容区分。唯一的根治是让 betly
换短名，而"官方 = 只有 teamclu"是唯一不需要维护名单的规则。

**不迁移，是因为迁移的代价比重新 onboard 大。** 官方用户的 `~/.teamclu` 路径在
新旧规则下完全一致——个人密钥、`local-cache.db`、遥测授权全部原地存活；硬切的
代价只有"重新 onboard 一次"加"丢掉本机 runtime 索引"，而后者本来就有云端
`agent_runtimes` 作为主 resume 路径。换来的是一次性删掉全部迁移代码：
`migrate_legacy_file()`、`supabase.toml` 迁移、`secret_store` 的自愈搬运器、
`workspace_link::migrate_legacy_dir`、桌面端 `storage_migration.rs`、前端
`storage-migration.ts`。这些代码今天仍在活跃执行，且其中至少两处正在制造问题。

## 考虑过的替代

**保留 `teamcludev` 为官方**——查证后发现它不由任何 checked-in 配置产出：
`build.config.dev.json` 的 `shortName` 也是 `teamclu`（只有 `name` 叫 "TeamClu
Dev"）。移除它对本仓库产出的任何构建都是 no-op，且不影响任何已发布迁移——那些
迁移读的是独立常量 `LEGACY_OFFICIAL_DEV_STORAGE_DIR`，门控是"当前构建是否官方"。

**`team-secrets/` 继续留在根目录**——`docs/amuxd-home-directory.md` 曾明确写着
"故意不放在 `teams/<id>/` 下，避免被 git sync 推上云"。这个理由在当前代码里已
不成立：同步引擎只扫 `teams/<id>/teamclu-team/`，`teams/<id>/cloud/` 正是靠"做
它的兄弟目录"躲开扫描的。新布局进一步把被扫描的范围收紧到 `teams/<id>/shared/`
一层，"往团队目录里加文件会不会被推上云"的答案变成恒定的"不会"。

**为 betly 单开一条密钥目录搬运**——会把刚删干净的迁移代码请回来一份，且那份
代码此后永远没人再测。betly 用户重录一次 API key，在发版说明里明说。

**自动迁移 `~/.amuxd`**——唯一不幂等的步骤是密钥重封（根主密钥 → 每团队密钥），
失败即密文与密钥错配。为了省一次 onboard 而引入一条会静默毁掉团队密钥的路径，
不划算。

## 后续影响

- **旧数据一次性删除**，包括根目录的 `backend.toml`：硬切后无人再读它，但里面
  的 `refresh_token` 仍是一把能换 access token 的活钥匙，留在盘上是纯风险。
  同理删除旧 `daemon.toml`（`[channels]` 的 bot token、`agents.cursor.api_key`）
  和 `bin/` 残留
- **旧版 amuxd 二进制会以 unclaimed 启动**：`DaemonConfig` 没有
  `deny_unknown_fields`，旧文件仍能解析，但新版把 `backend.toml` 移走后旧版找不
  到凭证。这是一个用户可见的坏状态，优于静默双写两份身份
- `~/.amuxd` 的清理与布局由 **daemon 自己**在启动早期执行（持锁之后、
  `DaemonConfig::load` 之前）。`~/.{brand}` 与 workspace 元数据仍归桌面端——
  谁拥有目录谁负责
- `teams/<id>/shared/teamclu-team/` 的路径变化由 `ensure_workspace_link()` 惰性
  修复；workspace 侧的 `teamclu-team` 软链名不变
- 护栏：根目录白名单单元测试 + 禁止 `.amuxd` / `.teamclu` 字面量出现在
  `teamclu-runtime-env` 之外的棘轮测试（首版 46 个文件的 `DEBT` 清单，此后只许
  缩短；清理干净却忘记从清单删除同样会红）。两者跑在
  `cargo test -p teamclu-runtime-env`——该 crate 的测试此前从未进过 CI

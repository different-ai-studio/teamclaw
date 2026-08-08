# 废除 Runtime 概念 —— 迁移计划

**范围**：desktop（`packages/app/` + `apps/desktop/`）、daemon（`apps/daemon/`）、
Cloud API（`services/fc/`）、共享 schema（`proto/`、`crates/`）。
**iOS 明确不在本轮范围内** —— 因此全程不删任何 FC 端点、不停写 `agent_runtimes`。

**设计依据**：ADR-0002 / 0003 / 0004 / 0005，
术语见 [`proto/CONTEXT.md`](../../proto/CONTEXT.md) 与
[`apps/daemon/CONTEXT.md`](../../apps/daemon/CONTEXT.md)。

## 起因

某团队 `agent_runtimes` 积到 1306 行 / 1296 session，
`POST /v1/sessions/display-rows` 把 1296 个 uuid 拼进一条 PostgREST GET，
URL 约 48KB，kong 返回 414 → session 列表空白。

根因不是数据量，是 `runtime_id` —— 每次启动新生成的一次性 id 被当作持久标识使用。
详见 ADR-0004。

## 目标状态

| 原 | 新 | 键 | 存在形式 |
|---|---|---|---|
| Runtime（全局进程层） | AgentHost | 每设备 1 个 | 进程 |
| Runtime（每次 spawn 层） | Attachment | `session_id` | 纯内存 |
| `runtime_id` | 废除 | — | — |
| `agent_runtimes` 表 | 废除（阶段 7，阻塞于 iOS） | — | — |

唯一 retain：`amux/{team}/{actor}/state`，携带
`active_agent_type` / `backend_health` / ModelCatalog / DefaultModel /
`available_commands` / `LiveSession[]`。一条 topic、一个 actor、每一项都有界。

---

## 阶段 0 — 止血

可立即上线，与其余阶段无依赖。

> **更正（2026-08-08）**：原文写「iOS 在阶段 7 前一直打 `GET /v1/runtime`，这是它唯一的
> 保护」。核实不成立 —— iOS 已不调用任何 runtime REST 端点，`agent_runtimes` 在
> `AMUXCore` 里只剩注释。所谓的兼容层从一开始就没在保护它。

- [ ] `chunkedIn(ids, size, fn)` helper（100 uuid 一片）→ `services/fc/src/lib/supabase-repo/shared.ts`
- [ ] 套用到 `supabase-repo.ts` 的 7 处无上限 `.in()`：L115 / 1903 / 1992 / 2012 / 2337 / 2604 / 2629
- [ ] `supabase-repo.ts:149` 的 `global.fetch` 加长度守卫：URL > 4KB → warn + Sentry；`NODE_ENV=test` 直接 throw
- [ ] `packages/app/src/lib/daemon-runtimes.ts:47` 的 `Promise.all` 拆成各自 catch，失败回退 id 当显示名
- [ ] 测试：2000 个 id 的分片次数断言

## 阶段 1 — 验证前提（无代码，阻塞阶段 5）

- [ ] `eviction.rs:26` 的 `h.event_rx.is_some()` —— 正在被消费事件的挂载是否永久豁免驱逐？
      若是，上限 16 不成立
- [ ] `rpc/req` 串行假设 —— 一个 actor 全部命令过同一 topic，QoS1 + 按 session_id 分派是否够

## 阶段 2 — DB：Participant 获得状态

```sql
ALTER TABLE amux.session_participants
  ADD COLUMN workspace_id uuid,
  ADD COLUMN model text,
  ADD COLUMN last_processed_message_id uuid;
```

- [ ] 迁移 + 回填（每个 `(session_id, agent_id)` 取 `updated_at` 最新的 `agent_runtimes` 行）
- [ ] ⚠️ **迁移文件名同 PR 加进 `.github/workflows/self-host-deploy.yml` 的清单** ——
      否则部署静默跳过且报成功
- [ ] FC schema + repository 读写新列
- [ ] `PATCH /v1/agents/runtimes/:id/cursor` 内部改写为写 `session_participants`
      （URL 与请求体不变，daemon 无感）
- [ ] daemon cursor 读取切到新来源（`collab_runtime_ensure.rs:282`）
- [ ] `agent_runtimes` 继续双写

行为完全不变，可独立发布。

## 阶段 3 — daemon：Attachment + 新 actor retain（与旧 retain 双发）

- [ ] 3a `RuntimeHandle` → `SessionAttachment`；`RuntimeManager.agents` 改按 `session_id` 键控
- [ ] 3b `ActorPresence` 加 6 字段；`publish_all_agent_states` → `publish_actor_state`，
      **在每次 attach / detach 时触发**
- [ ] 3c `ModelMru` 加 worktree 维（`by_backend` → `by_backend_worktree`）
- [ ] 3d ModelCatalog 去重编码（union 一份 + 每组索引表，实测 5.3 KB）

3b 的单一发布点顺带解决 gateway / cron —— 它们的挂载本就进 `RuntimeManager.agents`
（`channels/agent_handle.rs`、`server/cron.rs:196`），发布挂在 attach 上即自动覆盖。

~~旧的 `runtime/{rid}/state` 继续发（iOS 与未迁移的桌面端仍在读）。~~

> **更正（2026-08-08）**：这条在写下的**次日**就作废了 —— `1b5a25ee` 直接停发了
> per-spawn retain（`publish_runtime_state_by_id` 被掏空成转发 actor 快照）。同一天
> 之前，`657de72e` 已经 `DROP TABLE agent_runtimes`。iOS 因此被夹在两次删除中间：
> 旧腿断了，新腿没接，agent 的模型既看不到也选不了。修复见
> [`2026-08-08-ios-runtime-removal-migration.md`](./2026-08-08-ios-runtime-removal-migration.md)。

## 阶段 4 — proto + 三端：命令通道合并（ADR-0003）

- [ ] `AcpCommand` 9 个变体 → `RpcRequest` method；`AcpStartAgent`/`AcpStopAgent`
      并入已有的 `runtime_start`/`runtime_stop`
- [ ] daemon subscriber 双接（`mqtt/subscriber.rs:80` 保留一段时间）
- [ ] 桌面端发送方切换：`interrupt-agent.ts` / `answer-question.ts` /
      `reply-acp-permission.ts` / `ensure-agent-runtime.ts`
- [ ] `AcpRequestTurnHistory` scoping 注释改写（`amux.proto:214-217`）

单独就有收益：中断有回执了。

## 阶段 5 — daemon：detach 策略（阻塞于阶段 1）

- [ ] 空闲驱逐**默认开启**，阈值 30 分钟（当前 `server.rs:1281` 未设即禁用）
- [ ] LRU 上限 16
- [ ] 这一步之后 `LiveSession[]` 才真正有界

## 阶段 6 — desktop：读取切到新 retain

`runtime-state-store.ts:160` 订阅从 `runtime/+/state` 换成 `{actor}/state`，然后：

| 消费方 | 数量 | 新来源 |
|---|---|---|
| `daemon-runtimes.ts` | 4 | **整个文件删除** |
| `listRuntimeTargetsForSession` | 6 | 阶段 4 的 rpc/req + session_id |
| `listLatestAgentRuntimeHints` | 4 | actor retain |
| `listSessionRuntimeModels` | 2 | `participant.model` + retain ModelCatalog |
| `fetchLatestRuntimeForSession` | 1 | `participant.workspace_id` |
| `CronJobDialog:90` | 1 | retain ModelCatalog（跨 worktree 遍历） |
| `updateRuntimeModel` | **0** | 死代码，直接删 |
| `session-workspace-sync.ts` | 1 | `participant.workspace_id`，分页拉取 |

## 阶段 7 — 收尾（**已完成，2026-08-08**）

停发旧 retain、停写 `agent_runtimes`、删表 —— 这三项实际发生在 8/3~8/4，早于本文
预期。iOS 的迁移随后补上（见上方链接），并顺带完成了 ADR-0004 里一直没落地的
`RuntimeManager.agents` 改按 `session_id` 键控。

`default_agent_type` → `active_agent_type` 更名仍未做。

---

## 依赖图

| 阶段 | 阻塞于 |
|---|---|
| 0 止血 | — |
| 1 验证 | — |
| 2 DB | — |
| 3 daemon Attachment | 2 |
| 4 命令通道 | — |
| 5 detach 策略 | 1、3 |
| 6 desktop 读取 | 3、4 |
| 7 收尾 | ~~iOS 迁移~~（已完成） |

0、1、4 互不依赖，可并行开工。

~~做到阶段 6 即可停 —— 那时桌面端已完全不碰 `agent_runtimes`，表与端点作为 iOS 兼容层保留。~~

> **更正（2026-08-08）**：并没有停在阶段 6。表在 8/3 就删了，旧 retain 在 8/4 就停发了，
> 而当时 iOS 尚未迁移 —— 那句「作为 iOS 兼容层保留」在写下时就已经不成立。教训：
> 计划文档里关于「另一端还依赖什么」的断言，要么当场核实，要么别写。

# amuxd 卸下模型偏好 —— 迁移计划

**范围**：daemon（`apps/daemon/`）、desktop（`packages/app/`）、iOS（`apps/ios/`）、
Cloud API（`services/fc/`）、共享 schema（`proto/`）。

**设计依据**：[ADR-0007](../adr/0007-amuxd-holds-model-capability-not-preference.md)，
术语见 [`proto/CONTEXT.md`](../../proto/CONTEXT.md)。

## 起因

amuxd 同时持有「这台设备能跑什么」（catalog，能力）与「上次用什么 / 现在用什么」
（MRU 与 DefaultModel，偏好）。偏好会被写坏：
`packages/app/src/lib/agent-model-auto-persist.ts:14-27` 记录的自我强化 bug 里，
客户端冷启动误选 → daemon 记进 MRU → 下个新 session 继承 → 每次重启再确认一遍。
把 MRU 服务给客户端修不了它，因为回灌路径还在。

ADR-0007 的切法不是把缺省值搬家，而是**取消缺省值**：所有入口在创建时把 model
定死，`unpinned 启动`这个状态不再存在，回灌路径随之消失。

## 排序规则

**客户端先具备能力，daemon 最后移除供给**（expand → migrate → contract）。
颠倒即复现 #742 那个 bug 类别 —— session pill 显示不出模型。

```
P0 ─→ P1 ─→ P3 ─→ P4 ─→ P5
P2 ───────────────────↗
```

顺序不能颠倒的三个理由：

- **P4 抢在 P3 前** → 客户端还在读 retain，字段已停发，pill 空白
- **P5 抢在 P2 前** → automation 既没缺省也没必填，直接跑不起来
- **P0 缺失** → P3「读云」读到的是冻结值，比现状更差（见下）

---

## P0 · 接通 `session_participants.model` 的写入路径

⚠️ **这一列今天没有写入者。** ADR-0005 与 `proto/CONTEXT.md` 都声称它是权威，
实际上：

- 列由 `services/supabase/migrations/20260803000000_participant_owns_agent_session_state.sql:25`
  加上，并做了一次性回填（从 `agent_runtimes.current_model` 取每个 `(session, agent)`
  的 `updated_at` 最新一行）
- 此后无人写：`supabase-repo.ts` 的 `upsertSessionParticipant` 只写 `role`，
  `updateParticipantCursor` 只写 `last_processed_message_id`；Cloud API 的
  `/v1/sessions/{sessionId}/participants/{actorId}` **只有 DELETE**；daemon 不碰
- 只有 `supabase-repo.ts:2455` 一处 select 会读到它

同批迁移的 `workspace_id` 与 cursor 都接上了写入路径，唯独 `model` 漏了 ——
这是 ADR-0005 遗留的半截迁移，与 ADR-0007 无关，**现在就在线上漏**。

**动作**

1. `services/fc/src/lib/repository-contract.ts` 加 `updateParticipantModel` 契约
2. `supabase-repo.ts` + `pg-repo/` 两个实现
3. `docs/openapi/teamclu-api.v1.yaml` 加
   `PATCH /v1/sessions/{sessionId}/participants/{actorId}`
4. `services/fc/src/lib/routes/` 路由 + 测试

**可独立发布**，发完那一列就活了。不依赖本计划任何其他阶段。

---

## P1 · daemon 开始上报事实（expand，不删任何东西）

1. `manager.rs::set_current_model` 调 P0 的端点写 `session_participants.model`。
   **加「值未变则跳过」短路** —— 六个调用点里 attach 时的解析会在每次 runtime 起
   时写同一个值。
2. gateway 的 `/model` 从内存 override（`channels/agent_handle.rs:107-111`，
   注释明写 "In-memory only"，daemon 重启即失）改为落库。

此阶段 daemon 新旧两套并供：retain 仍带 `current_model`，MRU 仍在。
**客户端零改动，行为不变。**

---

## P2 · automation 入口必填 model（与 P1 并行，无依赖）

- cron 创建：model 由可选改必填（前端表单 + 后端校验）
- channel 绑定：新增 model 必填

**存量回填**：已有的无 model cron 任务 / channel 绑定，在**本阶段**用当时 MRU
的头部回填。这是唯一无痛窗口 —— MRU 在 P5 才删，错过就只剩「首次运行报错要求
用户补」这一条路。

此阶段之后 automation 侧不再有 unpinned 启动。

---

## P3 · 两端建 MRU 并改读云（Tauri / iOS 并行，各自可独立发布）

每端各做一份：

- 新 MRU store，键 `(backend, team)`，含「记住的模型已从 catalog 消失」的降级
  （即原 `config::model_mru::first_available` 的语义）
- 首次发送强制选一次模型，预选 backend 的 config default
  （`runtime/opencode_http/client.rs:313`）。**不得自动取 `available[0]`** ——
  那是 provider 探测顺序，不稳定，且正是起因里那个 bug 的第一步
- `selectAgentModel`（`packages/app/src/lib/runtime-state-resolve.ts:495`）的 retain
  层改读 `session_participants.model`，**retain 暂留作 fallback**

retain 保留 fallback 就是灰度窗口：两端不必同时上线，先发哪个都不会坏。

---

## P4 · 停止填充 proto 字段（contract 第一步）

停发 `ActorPresence.default_model`(12) 与 `ActorPresence.worktrees`(7)。
**保留字段定义**，只停止填充。

两个字段必须一起停：`worktrees[0].default_model`（`WorktreeCatalog` 字段 3）是
同一个偏好的第二条通路，两端的解析链都写成
`presence.defaultModel || legacy?.defaultModel`
（`runtime-state-store.ts:312-313`、`SessionListViewModel.swift:429-432`），
只停 12 号，偏好照样从 7 号流进来。

**`RuntimeInfo.current_model` 不在本阶段** —— 计划原文列了它，但 ADR-0004
phase 7 已于 2026-08-04 停发 `runtime/{id}/state`，`RuntimeInfo` 整条消息今天
就没有发布者，无从"停发"。retain 上真正承载模型的是
`LiveSession.current_model`（`manager.rs:1489`，在 `ActorPresence.live_sessions`
里），它**保留** —— 那是 P3 客户端解析链里的 live 那一层，也是 ADR-0007
「daemon 仍在进程内跟踪当前模型」那条例外的出口。

**放行门槛（已于 2026-08-16 由决策豁免，未达成即执行）**：原定
`amux.actor_client_versions` 显示无低于 P3 版本的活跃 reporter。执行时 P3 尚未
发版，线上 P3 客户端为零；近 7 日活跃 tauri 13 / daemon 13 / expo 4 / ios 2 台
全部低于门槛，其模型 pill 会退回到各自的兜底。这是明知代价的选择，不是疏漏。

该表键为 `(actor_id, client_type, device_id)`，**四**端在上报各自的
`client_type`（原表漏了 expo）：

| client_type | 上报处 |
|---|---|
| `tauri` | `packages/app/src/App.tsx:824` |
| `ios` | `AMUXCore/CloudAPI/CloudAPIRepositories.swift` |
| `daemon` | `apps/daemon/src/backend/cloud_api/mod.rs` |
| `expo` | `apps/expo/src/features/notifications/report-client-version.ts:10` |

expo 不读这两个偏好字段，所以本阶段不波及它；它读的 `RuntimeInfo.currentModel`
早已是空通路（`decodeRuntimeInfo` / `handleRuntimeInfo` 均无生产调用方）。

---

## P5 · 删 daemon MRU（contract 第二步）

**daemon**

- 删 `config/model_mru.rs`
- 删 `manager.rs` 的 `actor_default_model` / `recent_models` / `learn_session_model`
- 摘掉 `set_current_model` 里的 `model_mru.record/save`（函数本身保留）
- 删 `http/workspaces.rs` 的 `BackendCatalog.recent_models` 与 `attach_recent_models`
- 六个 `set_current_model` 调用点逐一确认语义仍成立：`daemon/server/rpc.rs`、
  `daemon/server/messaging.rs`、`daemon/server/runtime_lifecycle.rs`、
  `daemon/collab_runtime_ensure.rs`、`http/runtime_adapter.rs`、
  `runtime/manager/model_apply.rs`

**客户端**

- 删 `lib/local-daemon-model-catalog.ts` 的 `recentModels` 通道与
  `firstAvailableRecentModel`
- 删 `lib/agent-model-fallback.ts::localRecentModelFallback`
- 删 `lib/agent-model-auto-persist.ts`

**存储** —— 删 `~/.amuxd/cache/model-mru.toml`，不做迁移。
`model-catalog.toml` 不动。

> 刻意的不对称：toml 立即删，proto 字段缓退。toml 只有 daemon 自己读；proto 字段
> 有线上老客户端在读。（P4 的门槛被豁免后，这条不对称在本次执行中失去意义 ——
> 两者同批发出。）

**顺带清掉的死代码** —— `learn_session_model` 一删，它独占的
`AgentBackend::session_model` 就没有调用方了，连同三个后端的实现一并删除
（opencode_http / claude_agent / cursor_sdk，pi 用的是 trait 默认实现）。
每一处的注释都写着自己存在的理由是「teach the device MRU」。

`client::session_model_id` **保留** —— 它看着同名，但服务的是 resume 路径
（`opencode_http/mod.rs:755`：重新挂上一个已有会话时读回它上次实际跑在什么模型
上）。那是关于这一个会话的事实，不是设备级偏好。

---

## 验收

| 场景 | 期望 |
|---|---|
| 全新安装首次发送 | 强制选一次模型，不自动选 |
| iOS 打开 Tauri 建的 session | 显示与 Tauri 一致的模型（读云，非 retain） |
| gateway `/model` 改模型后重启 daemon | 模型保持（P1 落库，不再是内存） |
| cron 任务无 model | P2 后无法创建；存量已回填 |
| 换设备 / 重装 | MRU 丢失，回到强制选一次 —— **预期行为，非 bug** |
| 客户端误选一个模型 | 只影响本次；不再回灌到下一个新 session |

## 已知代价（ADR-0007 已接受）

1. MRU 逻辑两端各实现一遍 —— amuxd 变瘦，系统总复杂度上升
2. 换端 / 重装丢 MRU
3. gateway `/model` 失去「常用置顶」（`recent_models` 没了）
4. 首次使用多一次强制选择
5. cron / channel 创建表单各多一个必填项
6. daemon 仍写一个云端列，不是「完全不碰模型」

## 不在本轮范围

`model-catalog.toml` 的键仍是 `(backend, worktree)`。按
`proto/CONTEXT.md` ModelCatalog 条目的查证（某设备 15 个 worktree 两两 diff，
差异全部来自团队 LiteLLM 网关模型与探测时间先后），catalog 真正的函数是
`(backend, team)`。收敛存储键是一次独立改动。

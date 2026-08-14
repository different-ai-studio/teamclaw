---
status: accepted
---

# 一个 Actor 任一时刻只运行一个 AgentType

一台设备可以装多个后端二进制（本机实测 opencode + pi 并存，`model-catalog.toml`
里两者的目录都被探测缓存过），但我们决定 **任一时刻只有一个 AgentType 是活跃的**。
切换是一次模式变更，不是并发。

`agents.agent_types` 保留为**能力集合**（设置页的切换下拉框需要它作为数据源），
`agents.default_agent_type` 保留为**当前活跃值**（字段名待更名为 `active_agent_type`）。

## 为什么

并发多后端会让「这个 actor 现在能用哪些模型」失去确定答案。
[ModelCatalog](../../proto/CONTEXT.md#modelcatalog) 的键是 (AgentType, Worktree)，
若一个 actor 同时活跃 opencode 与 pi，它的 retain 就必须携带两套目录，
而客户端在无 session 语境下（如 `CronJobDialog` 的模型选择器）无从判断该用哪套。

这不是假想问题：`packages/app/src/lib/runtime-state-resolve.ts:48-53` 已经为此
写了一段特判 —— 「同一 agent 的不同 runtime 可能后端与模型目录都不同
（一个陈旧的 opencode session vs 一个新鲜的 pi session）」。那段特判存在的唯一原因
就是并发多后端，取消并发即取消该特判。

## 放弃了什么

「同一设备上 opencode 与 pi 同时服务不同 session」这个真实能力。

## 切换活跃后端时会发生什么

**不存在"切换时还在跑的 session"。** 活跃后端的权威是 daemon 自己的配置
（`~/.amuxd/daemon.toml` 的 `[agents] local_agent`），`RuntimeManager.default_agent_type`
在构造时定死；切换 = 改配置 + 重启 daemon。而
[Attachment](../../apps/daemon/CONTEXT.md#attachment) 是纯内存态，随重启全部消失。
本 ADR 的不变式在任何时刻都不被违反。

云端 `agents.default_agent_type` 是 daemon 通过 `ensure_agent_types` 上报的**镜像**，
daemon 从不读回 —— 方向是 daemon → 云。

**已存的 per-session 模型选择采用惰性失效**：切换不清空
[Participant](../../proto/CONTEXT.md#participant) 的 `model`，而在 attach 时对当前
[ModelCatalog](../../proto/CONTEXT.md#modelcatalog) 校验，命不中则回退到
[DefaultModel](../../proto/CONTEXT.md#defaultmodel)。

> **后记（ADR-0007）**：上一段最后那级回退已作废 —— DefaultModel 连同设备 MRU
> 一起从 daemon 移除。惰性失效的机制不变（不清空、在 attach 时校验），但命不中
> 之后不再有 daemon 侧的兜底值可回退，改由客户端 MRU 或用户显式选择补位。

理由：切换是「改配置 + 重启」，daemon 启动时无从区分"刚切过来"与"一直如此"，
主动清空需要额外持久化上次的 backend；而 attach 本来就要把 model 交给后端，
校验点已经存在。且两后端目录实测仅 3 项重叠（`team/default` / `team/max` /
`team/pro`，均为团队网关别名），主动清空会连这些跨后端有效的选择一起误删。

> 「存了可能过期的值」本身不是缺陷，「在使用点没有校验」才是。
> 这正是 `runtime_id` 与本方案的区别 —— 前者被直接拼进 MQTT topic 发出去，
> 没有任何校验点，失效表现为静默丢弃（见 ADR-0004）。

## ModelCatalog 没有查询接口 —— 这是刻意的

活跃后端只有一个，其全部 worktree 分组去重编码后仅 **5.3 KB**
（本机实测：8 组、条目合计 563、去重后仅 72 个不同模型 —— union 一份 4.2 KB
+ 每组索引表 1.1 KB）。因此 `ActorPresence` retain 直接携带全量，
**client 侧不存在按需查询通道**。

若未来有人想补一个「按 workspace 查目录」的接口：它答不出来。一个从未 attach 过的
worktree，daemon 手上也没有其目录 —— 那份目录是 attach 时探测得来的。所谓"查询"
实为**触发一次探测**，即在该目录下把后端拉起来，而调用方正站在模型选择器前等待。
该缺失场景已有降级：`manager.rs:906` 的 `models_for_or_any` 命不中即回退到任一
已知 worktree 的目录，实测偏差 1~3 个 / 72 个，且首次 attach 后即自动补正。

用一次昂贵探测换 2% 准确度，不划算。

> **后记（现状）**：这个接口后来还是建了 ——
> `GET /v1/workspaces/:id/model-catalog`（`http/routes.rs:144` →
> `workspaces::get_model_catalog`），且正如上文预判，它的实现就是「触发一次探测」
> （handler 会按需把后端拉起来，`http/workspaces.rs:704-708`）。
>
> 上文的顾虑没有被推翻，是被绕开了：调用方**不站在选择器前等待** ——
> `seedLocalDaemonModelsInBackground` 是 fire-and-forget，探测结果回来后合并进
> runtime state（`lib/local-daemon-model-catalog.ts:228-269`）。而且它是
> **loopback-only**，只够到本机 daemon，远端 actor 依旧只有 retain 一条路。
> 所以本节的结论对**远端**仍然成立，对**本机**已不成立。

## 后续影响

- `default_agent_type` → `active_agent_type` 更名（DB + FC schema + 三端）
- retain 中 [ModelCatalog](../../proto/CONTEXT.md#modelcatalog) 仅携带活跃后端的分组
  （本机 11 组 → 8 组）
- [ActorPresence](#) 的后端健康字段是**单值**而非 `map<agent_type, health>`
- `runtime-state-resolve.ts` 的跨后端特判可删

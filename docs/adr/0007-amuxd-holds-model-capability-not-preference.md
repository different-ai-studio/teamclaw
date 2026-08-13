---
status: accepted
---

# amuxd 只持有模型能力，不持有模型偏好

amuxd 继续维护 [ModelCatalog](../../proto/CONTEXT.md#modelcatalog)（这台设备能跑
什么），不再维护任何**模型偏好**：删除设备 MRU
（`config::model_mru` / `~/.amuxd/cache/model-mru.toml`）与由它派生的
[DefaultModel](../../proto/CONTEXT.md#defaultmodel)。

「某 session 用哪个模型」收敛为唯一答案 `session_participants.model`（ADR-0005），
daemon 是它的唯一写入者。「上次用了哪个模型」下沉为**客户端偏好**，Tauri 与 iOS
各持一份，键 `(backend, team)`，两端不承诺一致。

一条例外，也是与提议原案的唯一实质偏差：**daemon 仍在进程内跟踪 runtime 当前
绑定的模型**，因为它是消息级归属的唯一来源（见下）。它不再持久化、不再上 retain。

## 为什么

MRU 当初被从桌面 localStorage 上收到 daemon，理由写在
`apps/daemon/src/config/model_mru.rs:5-9`：gateway 与 cron 的 runtime 在 amuxd 里
起，读不到 localStorage，所以「上次用的模型」的答案取决于谁在问。这个理由成立，
但它解决的是**运行时缺省值从哪来**，代价是让 amuxd 持有了一份用户偏好 —— 而偏好
是会被写坏的：

`packages/app/src/lib/agent-model-auto-persist.ts:14-27` 记录了一个自我强化 bug ——
冷启动无 retain 时客户端写 `available[0]`，pick 压过一切，session 就跑在那个模型
上，daemon 把这次运行记进 MRU，MRU 头部从此是错的，下一个新 session 继承它，而
每次重启都会新建 session。**把 MRU 服务给客户端并不能修它**，因为回灌路径还在。
偏好和事实存在同一个进程里，客户端的一次误选就能污染设备级记忆。

本 ADR 换一条切法：**不是把缺省值搬家，而是取消缺省值**。所有入口在创建时把模型
定死 —— 桌面/iOS 首次发送时强制选一次，channel 绑定时必填，cron 任务创建时必填。
`unpinned 启动`这个状态因此不再存在，`RuntimeManager::learn_session_model`
（事后问 backend 实际用了哪个，以免新装机器的 MRU 永远为空）随之失去输入，可以整个
删掉。回灌路径断了，上面那类 bug 也就没有了载体。

保留进程内 current_model 的原因是查证出来的，不是设计偏好：
`apps/daemon/src/daemon/server/cron.rs:409-415` 给每条外发事件盖
`event.model = mgr.current_model(&agent_id)`，`cron.rs:242-259` 用它算 `run_model`
落库，注释明写不能用 `parsed.model_override`（那不是运行时真正 settle 的值）。
这不是显示兜底，是**数据归属**。gateway 与 cron 的消息没有客户端在场，没有第二个
角色能提供这个字段。

## 考虑过的替代

**连 `RuntimeInfo.current_model` 一起砍，客户端只记自己发过什么** —— 提议原案。
gateway/cron 消息的 model 归属无人可填；第二观察者（iOS 打开 Tauri 建的 session）
也失去信息源。改为「内存保留 + 不广播 + 写 `session_participants.model`」后两者都
成立。

**MRU 放云端按 actor 存** —— 技术上更优（跨设备一致，且顺带给 gateway/cron 一个
读源），但它把状态从 daemon 搬到了云，不是本次要的方向。明确接受每端各存一份、
换端即丢：MRU 在此被定性为客户端偏好，不是产品承诺。

**保留 `daemon.toml` 里一个 automation 默认模型作兜底** —— 被「创建时必填」吃掉：
没有任何 automation 入口会在运行时缺 model，配置项没有消费者。若保留，还得回答它
失效（模型下架 / key 过期）时怎么办 —— 静默替换等于把 MRU 换个名字重新发明，而
MRU 是**列表**恰恰是为了这层降级（`model_mru.rs:11-15`）。

**客户端空 MRU 时自动取 `available[0]`** —— `available` 的顺序是 provider 探测
顺序，不稳定；且这正是上面那个自我强化 bug 的第一步。改为强制用户显式选一次，
预选 backend 自己的 config default（`opencode_http/client.rs:313`）。

**客户端直接写 `session_participants.model`** —— gateway/cron 场景无解，最终会变成
「客户端写一部分、daemon 写一部分」。同一列两个写入者正是
`packages/app/src/stores/agent-model-pick-store.ts:8-12` 那条设计契约
（"There is no other writer"）花了代价才立下的规矩。

## 后续影响

**daemon**

- 删 `config/model_mru.rs`、`manager.rs` 的 `actor_default_model` /
  `recent_models` / `learn_session_model`
- `manager.rs::set_current_model` 保留（内存 + 写 `session_participants.model`），
  摘掉其中的 `model_mru.record/save`。它的六个调用点（`rpc.rs`、`messaging.rs`、
  `runtime_lifecycle.rs`、`collab_runtime_ensure.rs`、`runtime_adapter.rs`、
  `manager/model_apply.rs`）逐一确认语义仍成立
- `http/workspaces.rs`：删 `BackendCatalog.recent_models` 与 `attach_recent_models`
- gateway 的 per-session `/model` 从内存 override
  （`channels/agent_handle.rs:107-111`，"In-memory only"，daemon 重启即失）改为
  落 `session_participants.model`

**proto** —— 保留字段定义、停止填充，按 `ActorPresence.worktrees`(7) 现有的
`actor_client_versions` 门槛放行：`RuntimeInfo.current_model`、
`ActorPresence.default_model`(12)、`ActorPresence.worktrees`(7)。

**客户端**（Tauri + iOS 各一份）

- 新增 MRU store，键 `(backend, team)`，含「记住的模型已从 catalog 消失」的降级
  （即原 `model_mru::first_available` 的语义）
- 改写 `lib/local-daemon-model-catalog.ts`（去掉 `recentModels` 通道）、
  `lib/agent-model-fallback.ts::localRecentModelFallback`、
  `lib/agent-model-auto-persist.ts`
- `lib/runtime-state-resolve.ts::selectAgentModel` 的 retain 层改读
  `session_participants.model`

**存储** —— `~/.amuxd/cache/model-mru.toml` 直接删除，不做迁移；
`model-catalog.toml` 不动。

> 刻意的不对称：toml 立即删，proto 字段缓退。toml 只有 daemon 自己读；proto 字段
> 有线上老客户端在读，停发一个还有人读的字段，症状就是 pill 显示不出模型 —— 正是
> #742 刚修完的那类 bug。

**词典** —— `proto/CONTEXT.md` 的 [DefaultModel](../../proto/CONTEXT.md#defaultmodel)
条目随本 ADR 作废（#742 决策 4/6 被本 ADR 取代）；
[ModelCatalog](../../proto/CONTEXT.md#modelcatalog) 条目保留，但其中「daemon 持久化
于 `~/.amuxd/model-catalog.toml`」的路径写法本就漏了 `cache/`，一并订正。

**已知代价**（均为明确接受）

1. MRU 逻辑在两端各实现一遍 —— amuxd 变瘦，系统总复杂度上升
2. 换端 / 重装丢 MRU
3. gateway `/model` 失去「常用置顶」（`recent_models` 没了）
4. 首次使用多一次强制选择
5. cron / channel 创建表单各多一个必填项
6. daemon 仍写一个云端列，不是「完全不碰模型」

**本次不动** —— `model-catalog.toml` 的键仍是 `(backend, worktree)`。按
`proto/CONTEXT.md:68-71` 的查证（某设备 15 个 worktree 两两 diff，全部差异只来自
团队 LiteLLM 网关模型与探测时间先后），catalog 真正的函数是 `(backend, team)`。
收敛它是独立的一次改动。

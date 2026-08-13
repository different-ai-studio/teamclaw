# Proto Context

跨端共享 schema 的领域语言（`proto/*.proto` + `crates/teamclu-proto/` + `crates/teamclu-types/` + `crates/teamclu-transport/`）。
是所有 context 的权威上游 —— desktop / daemon / ios / android / mobile-rn 都在此处取定义。

## Glossary

### Actor
身份**逻辑实体**的基础类型，所有人和 agent 共享同一 id 空间。
DB 权威：`public.actors(id, team_id, actor_type, display_name)`。

```
actor_type ∈ {'member', 'agent'}
```

> 历史 proto 中的 `ActorType { HUMAN, PERSONAL_AGENT, ROLE_AGENT }` 待废弃，
> 统一为二值 `member | agent`。ROLE vs PERSONAL 的区分由 `agent_member_access`
> 表派生（多个 member 有 access ⇒ 角色 agent，仅 owner ⇒ 个人 agent）。
> 见 ADR-0001。

### Member
`actor_type='member'` 的 [Actor](#actor) 特化（1:1），代表**团队中的真人成员**。
DB：`public.members(id PK = actors.id, user_id → auth.users, status)`。
`member_id` ≡ HUMAN actor 的 `actor_id`（同一 UUID）—— 字段名差异是上下文偏好，不是不同实体。

### Agent
`actor_type='agent'` 的 [Actor](#actor) 特化（1:1），代表**一个 AI agent 身份**。
DB：`public.agents(id PK = actors.id, agent_kind, agent_type, capabilities, status)`。
区别于 `daemon.Runtime`（运行进程）—— Agent 是身份/配置，Runtime 是其在某 device 上的运行实例。

### AgentKind
Agent 的**归属类型**枚举：

```
agent_kind ∈ {'personal', 'team'}
```

- `personal` —— 个人 agent，仅 owner 可访问/调度
- `team` —— 团队角色 agent，团队成员按 [`agent_member_access`](#agent_member_access) 授权访问

⚠️ DB 当前 `agents.agent_kind text` 字段实际存的是 [AgentType](#agenttype) 的值
（claude-code/opencode/codex），与本术语**冲突**。迁移计划：
1. 新增列 `agents.agent_kind ∈ ('personal','team')`
2. 现有 `agents.agent_kind` 重命名为 `agents.agent_type`
见 ADR-0001。

### AgentType
Agent 的**后端实现种类**取值域：`'claude-code' | 'opencode' | 'codex' | …`
对应 daemon `amux.AgentType` 枚举（沿用此名）。

一个 Agent **具备多个 AgentType，但任一时刻只有一个是活跃的**：
- `agents.agent_types` (jsonb 数组) —— **设备能力**：这台设备装了哪些后端二进制
- `agents.default_agent_type` —— **当前活跃**（单值，必须 ∈ `agent_types`）

「具备」是能力，「活跃」是状态。切换活跃后端是一次**模式变更**，不是并发 —— 见 ADR-0002。

⚠️ `default_agent_type` 的字段名是历史遗留，语义已不是"默认值"而是"当前就是它"。
应更名为 `active_agent_type`。

_Avoid_: 默认后端、default backend（会读成"可以被覆盖的缺省值"，但它不可被单次覆盖）

### ModelCatalog
某 [AgentType](#agenttype) 下**可选模型的全集**，**设备级一份**。
proto: `repeated ModelInfo`；daemon 持久化于 `~/.amuxd/model-catalog.toml`，
键为 `by_backend.{agent_type}.{worktree}`。

⚠️ 存储按 worktree 分片，**上报不分片**。存储是观测记录（每次探测如实落账），
上报的是设备级并集。此前正文写的「不是 Actor 的属性 —— 同一 actor 在不同
worktree 下目录不同（实测 68~72 个模型）」**已被查证推翻**：某设备 15 个
worktree 条目两两 diff，全部差异只来自团队 LiteLLM 网关模型与探测时间先后，
无一来自目录本身（#742 决策 3）。

**存储**保留全部 AgentType 的目录（切回旧后端时无需重探）。
**`ActorPresence` retain 是 client 侧的唯一来源**，携带当前活跃 AgentType 的
设备级并集 —— 不存在按需查询通道，见 ADR-0002。

_Avoid_: available models（字段名可以，术语不要）、模型列表

### DefaultModel
某 ([Actor](#actor), [AgentType](#agenttype)) 组合下**上次实际使用**的模型，
即该组合 MRU 列表的表头。是**记忆**，不是配置项，用户无处显式设定它。
daemon 权威：`config::model_mru`（`~/.amuxd/model-mru.toml`）。

键里**不再含 Worktree**（#742 决策 4）：目录级 MRU 已删除，gateway / cron 无论
在哪个目录启动都得到同一个答案。消费语义是显示兜底
（`currentModel || defaultModel`）；会话真正用的模型按 ADR-0005 存于
`session_participants.model`，不受此影响。

_Avoid_: 默认配置、preferred model、fallback model（后者指目录首项那一级派生兜底，是另一回事）

### Team
顶层组织单元。所有 Actor / Workspace / Idea / Session 都 scoped to 单个 team。
DB：`public.teams(id, slug, name)`。`team_members` 表关联 member↔team↔role。

### Participant
[Actor](#actor) 在某个 [Session](#session) 中的**参与实体**。
DB 权威：`amux.session_participants`，唯一键 `(session_id, actor_id)`。

对 `actor_type='agent'` 的参与者，它**拥有该 agent 在该 session 中的工作状态**：

| 列 | 含义 |
|---|---|
| `workspace_id` | 这个 agent 在这个 session 里用哪个 [Workspace](#workspace) |
| `model` | 这个 agent 在这个 session 里用哪个模型 |
| `last_processed_message_id` | 这个 agent 读到哪儿了（重启后 catch-up 用） |

member 参与者这三列恒为 NULL —— 不是数据缺失，是不适用。

> 早前本条写作「非独立 DB 表实体」。该表述是错的，而且代价具体：上述三样状态
> 因此无处可挂，落到了每次启动新建行的 `agent_runtimes` 上，某团队实测积到
> 1306 行 / 1296 session。见 ADR-0005。

区别于 desktop 的 **engaged agent**（输入框当前对准的那一个 agent，客户端本地状态，
每 session 至多 1 个，不落库）—— 那是 UI 选择，不是参与关系。

_Avoid_: 关联记录、join table row（它有自己的状态，不只是连接两端）

### Session
跨端一致的会话单元，scoped to 单个 [Team](#team)。
proto: `SessionInfo { session_id, session_type, team_id, title, participants, primary_agent_id, idea_id, … }`。

### SessionType（弃用）
proto 历史枚举 `CONTROL | COLLAB`，已弃用。
daemon 一律为新 session 打 `UNKNOWN`（见 `apps/daemon/src/teamclu/session_store.rs:110`）。
所有 session 当前是单一种类，无需此字段区分。新代码不要读不要写。

### Workspace
proto 字段引用 `workspace_id`，DB 权威：`public.workspaces(team_id, path, …)`。
desktop 端的 [Workspace](../packages/app/CONTEXT.md#workspace) 是其本地视图。
**团队级注册**，与 [Worktree](#worktree)（设备级实体化）不是同一物。

### Worktree
一个 [Workspace](#workspace) 在**某台设备上**实体化出的本地绝对路径。
一个 Workspace 在每台设备上有 0 或 1 个 Worktree —— 未注册的设备上映射为空
（`resolveLocalPathForCloudWorkspace` 返回 `null`）。
**不再**是 [ModelCatalog](#modelcatalog) 或 [DefaultModel](#defaultmodel) 的键
（#742 决策 3/4）—— 二者都已收敛为设备级。

⚠️ Worktree 是**绝对路径**，含设备使用者的用户名与目录结构。
当前 `RuntimeInfo.worktree` 随团队级 retain 广播给全团队 —— 待处理的信息泄漏点。

_Avoid_: 本地 workspace、workspace path（会与团队级 Workspace 混淆）

### Idea / Claim / Submission
session 内的产品工作流单元：Idea 被 Claim（认领）后 Submission（提交）。
DB：`public.ideas`，proto: `Idea / Claim / Submission`。
状态机：`OPEN → IN_PROGRESS → DONE`。

### Turn
runtime 视角的一次完整 ACP 往返。
proto 中每条 `Message` 携带 `turn_id` —— daemon 为同一 ACP turn（Idle→Active→…→Idle）内 emit 的所有 AgentReply 打同一 id，客户端据此聚合渲染。
详见 daemon CONTEXT。

## Identity Triple（addressing）

RPC 寻址用**三套并存的 id**，不是同一物：

| id | 是什么 | 谁拥有 |
|---|---|---|
| `actor_id` | 逻辑身份（[Actor](#actor) 主键） | Supabase 注册的人或 agent |
| `client_id` | **安装实例** UUID | 每个 iOS/mac 安装一个；同一人多设备多 client_id |
| `device_id` | **daemon 进程**实例 id | daemon-to-daemon 通信时用 |

跨端补充：
- `member_id` = HUMAN actor 的 `actor_id`，仅是字段名偏好
- `peer_id` 在 collab 模块 ≈ 对端 `device_id`

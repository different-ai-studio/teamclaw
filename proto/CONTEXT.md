# Proto Context

跨端共享 schema 的领域语言（`proto/*.proto` + `crates/teamclaw-proto/` + `crates/teamclaw-types/` + `crates/teamclaw-transport/`）。
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

DB 上一个 Agent **可同时支持多个 AgentType**：
- `agents.agent_type` —— **支持列表**（数组），如 `['claude-code','opencode']`
- `agents.default_agent_type` —— **当前默认选定**（单值，必须 ∈ `agent_type`）

启动 [Runtime](../apps/daemon/CONTEXT.md#runtime) 时若 RuntimeStartRequest 未指定 type，
daemon 使用 `default_agent_type`。

### Team
顶层组织单元。所有 Actor / Workspace / Idea / Session 都 scoped to 单个 team。
DB：`public.teams(id, slug, name)`。`team_members` 表关联 member↔team↔role。

### Participant
[Actor](#actor) 作为成员加入某个 [Session](#session) 的关联记录（含 joined_at）。
proto 中是 SessionInfo 的内嵌列表；非独立 DB 表实体。

### Session
跨端一致的会话单元，scoped to 单个 [Team](#team)。
proto: `SessionInfo { session_id, session_type, team_id, title, participants, primary_agent_id, idea_id, … }`。

### SessionType（弃用）
proto 历史枚举 `CONTROL | COLLAB`，已弃用。
daemon 一律为新 session 打 `UNKNOWN`（见 `apps/daemon/src/teamclaw/session_store.rs:110`）。
所有 session 当前是单一种类，无需此字段区分。新代码不要读不要写。

### Workspace
proto 字段引用 `workspace_id`，DB 权威：`public.workspaces(team_id, path, …)`。
desktop 端的 [Workspace](../packages/app/CONTEXT.md#workspace) 是其本地视图。

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

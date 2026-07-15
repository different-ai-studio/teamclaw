---
status: accepted
---

# ActorType 简化为 `member | agent`；个人/团队归属下放到 AgentKind

历史 proto `enum ActorType { HUMAN, PERSONAL_AGENT, ROLE_AGENT }` 与 Supabase
权威 schema `actors.actor_type ∈ ('member','agent')` 不对齐，且把 agent 的
"个人 vs 团队"语义混进了 actor 类型枚举。

我们决定：

1. **以 DB 为准**，proto 的三值 `ActorType` 废弃，统一为二值 `member | agent`。
2. "个人 agent vs 团队角色 agent" **不**用 ActorType 表达，而是落到
   `agents.agent_kind ∈ ('personal','team')` 这个独立字段上，作为 Agent 的
   归属属性。
3. 当前 DB 中 `agents.agent_kind text`（实际存的是 claude-code/opencode/codex）
   需迁移：重命名为 `agents.agent_type`，并新增 `agent_kind` 字段承载
   `personal|team`。

## 术语分工

| 字段 | 取值 | 表达 |
|---|---|---|
| `actors.actor_type` | `member \| agent` | 这是人还是 AI |
| `agents.agent_kind` | `personal \| team` | 个人 agent 还是团队角色 agent |
| `agents.agent_type` | `text[]`，元素 ∈ `{claude-code, opencode, codex, …}` | 此 Agent **支持的**后端实现列表 |
| `agents.default_agent_type` | 同上单值，∈ `agent_type` | **当前默认**后端 |

## Considered alternatives

- 保留 proto 三值 ActorType：否，把"归属"塞进"类型"会导致 personal→team 的
  升级变成数据迁移而非属性变更。
- 通过 `agent_member_access` 行数推导 personal vs team：否，缺乏显式信号，
  零成员访问的 team agent 会被错误识别为 personal。
- 沿用 `agents.agent_kind` 同时表示后端种类：否，与 AgentKind 语义冲突。

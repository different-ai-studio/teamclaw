---
status: accepted
---

# Agent 在某 Session 中的工作状态归 Participant 所有

`workspace_id`、`model`、`last_processed_message_id` 三样状态改为
`amux.session_participants` 上的列，由
[Participant](../../proto/CONTEXT.md#participant) 实体拥有。
member 参与者这三列恒为 NULL。

## 为什么

三样状态的自然键都是 **(session, actor)** —— 恰好就是 `session_participants`
的唯一键。它们此前挂在 `agent_runtimes` 上，而那张表的键是
`(agent_id, backend_session_id)`，每次启动新增一行、从不删除。

根因在词典：`proto/CONTEXT.md` 原先把 Participant 定义为「非独立 DB 表实体」。
一个被声明为「不是实体」的东西无法拥有状态，于是这些状态无处可挂，落到了唯一
一张看起来相关的表上。某团队实测 1306 行 / 1296 session，`/v1/sessions/display-rows`
把 1296 个 uuid 拼进一条 PostgREST GET，URL 约 48KB，kong 返回 414。

这是一次**词典错误直接产出线上故障**的记录，值得单独留痕。

## 考虑过的替代

**新建 `session_agent_state` 表** —— 主键与 `session_participants` 完全相同
（`(session_id, actor_id)`），还需一个指向同一对的外键。纯间接层。

**把 `last_processed_message_id` 拆出去**（高频游标不与稳定配置同行）——
查证后不成立：`daemon/runtime_cursor.rs` 的游标是**每条入站用户消息**更新一次，
人类节奏，与该行 `updated_at` 本来的变更频率同量级。

## 后续影响

- migration：加三列 + 从 `agent_runtimes` 按 `(session_id, agent_id)` 取
  `updated_at` 最新一行回填。**文件名须同 PR 加入
  `.github/workflows/self-host-deploy.yml` 的迁移清单**，否则部署静默跳过且报成功
- `PATCH /v1/agents/runtimes/:id/cursor` 内部改写为写 `session_participants`，
  URL 与请求体不变，daemon 无感
- `agent_runtimes` 表在 iOS 迁移完成后可整表删除（见 ADR-0004）

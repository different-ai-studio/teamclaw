---
status: accepted
---

# 废除 Runtime 概念，改为按 session_id 键控的 Attachment

`Runtime` 一词同时指两个层级：**全局 opencode 进程**（每设备一个，`CONTEXT.md`
词典里描述的那个）与**每次 spawn 的句柄**（`runtime_id` 键控的那个，代码、proto、
DB、MQTT topic 里实际使用的那个）。我们决定拆开：前者叫
[AgentHost](../../apps/daemon/CONTEXT.md#agenthost)，后者叫
[Attachment](../../apps/daemon/CONTEXT.md#attachment) 并改为 **按 `session_id` 键控**。
`runtime_id` 废除。

## 为什么

一个词跨两个层级，代码在哪一层操作全靠上下文猜。三处已发生的损害：

1. **词典与代码相反**。`apps/daemon/CONTEXT.md` 原文写 "一个 Runtime 可承载多个
   Session"、"Session ↔ Runtime 为多对一"；而 `daemon/server/messaging.rs:84-86`
   写 "Each runtime is bound at spawn time to ONE session"。两边都对 —— 说的是
   不同层级。
2. **`runtime_id` 结构上无法保持正确**。它是每次 spawn 新生成的一次性 id，写进
   DB 的那一刻就开始过期。`packages/app/src/lib/runtime-state-resolve.ts:21-22`
   自陈 "Often stale; treat as a hint, not as truth"，
   `docs/debug/interrupt-agent-stale-runtime.md` 记录了它造成的静默中断失败。
3. **基数爆炸**。一个 session 累积 N 个 runtime 行（N = 历次 spawn），实测某团队
   1306 行 / 1296 session。按 `session_id` 键控后每 (actor, session) 恰好 0 或 1 个。

## 关键性质

Attachment 是**纯内存态** —— 没有 DB 行，没有 retain topic。这消掉了整类
"内存说有 / DB 说有 / broker 说有，三方不一致" 的缺陷，因为只剩一个真相源。

## Detach 条件

空闲 **30 分钟**，或挂载数达上限 **16** 时按 LRU 挤出，先到先触发。

这两个数是**领域参数**而非调优项：它们定义了「待命」这个用户可感知状态的保质期
与容量。阈值一到即 detach，条目消失，session pill 从"待命"变"冷" —— 集合边界与
用户看到的语义同步变化。

单靠空闲超时（B）上界仍依赖用户行为（阈值内能开多少 session）；单靠容量上限（C）
则与空闲时长无关。叠加后两种失控都堵住。

## 考虑过的替代

- **保留 Runtime，只把 `runtime_id` 换成稳定值（= session_id）** —— 改动最小，
  但保留了一个跨两层的词，未来读者仍会踩同一个坑。
- **每 session 一个 retained topic** —— 键稳定不会被 respawn 放大，但仍随历史
  session 数增长，且实证「停止时清 retain」不可靠（`clear_runtime_state` 只在
  驱逐路径调用，而驱逐默认关闭；崩溃 / kill -9 一律不清）。

## 后续影响

- `RuntimeHandle` → `SessionAttachment`；`RuntimeManager` 的 `agents` map 改按
  `session_id` 键控
- `RuntimeInfo` 19 个字段：1 个消失（`runtime_id`）、2 个上提至 actor、
  4 个删除（`session_title` 与 `sessions.title` 重复；`current_prompt` /
  `last_output_summary` / `tool_use_count` / `started_at` 只在离散 lifecycle
  事件时快照，中间不更新）、3 个改为派生、其余为 live 状态
- 空闲驱逐必须**默认开启**（当前 `idle_runtime_timeout_secs` 未设即禁用，
  见 `daemon/server.rs:1281`）

## `event_rx` 豁免门：查证结论

`eviction.rs:26` 的 `h.event_rx.is_some()` 本意是 mid-turn 保护
（配套测试 `evict_idle_skips_runtimes_with_checked_out_event_rx`），
`checkout_turn_for_acp` 取走、`checkin_turn` 归还，正常情况下仅在一次 turn 内为 None。

**但存在永久泄漏**：两处在 checkout 之后、绑定之前用 `?` 早退，
`CheckedOutTurn` 随之析构 —— 接收端被销毁而非归还，`handle.event_rx` 此后恒为 None，
该挂载永久豁免空闲驱逐。

| 位置 | 早退点 |
|---|---|
| `apps/daemon/src/channels/agent_handle.rs` | `send_prompt_raw(…).map_err(…)?` |
| `apps/daemon/src/daemon/server/cron.rs` | `send_prompt_raw(…).map_err(…)?` |

两处已改为失败时先 `checkin_turn` 再传播。此外，**LRU 上限的驱逐路径不应带这道门** ——
`stop_runtime` 本身不检查 `event_rx`，容量上限据此仍可回收泄漏的挂载，
使上界不依赖泄漏是否被修完。

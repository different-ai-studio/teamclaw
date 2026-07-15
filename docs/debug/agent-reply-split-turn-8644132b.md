# Agent 回复「断层」与最终只保留末段 — 根因与修复方案

**会话 ID:** `8644132b-afa4-4d3e-819c-204b2db0e86b`  
**日志:** `~/Library/Logs/com.teamclaw.app/acp-stream/8644132b-afa4-4d3e-819c-204b2db0e86b.log`  
**现象:** 同一轮 Agent 回复出现两个 MACMINI 头（图一）；结束后只剩最后一段正文（图二）。  
**调查日期:** 2026-06-05  
**状态:** 已实现（桌面端）；待手动复现 §4 / §6

---

## 1. 日志证据（可复核）

| 时间 (UTC) | 事件 | 说明 |
|------------|------|------|
| 16:16:51.973 | `message.created`（用户） | `[Command: using-superpowers] 写一个todo网站` |
| 16:16:52.068 | `statusChange` old=3 new=2 | Idle → **Active**，整轮开始 |
| 16:17:07.157 | 末段 `output` delta | 「…上下文**。**」 |
| **16:17:07.377** | **`message.created` #1（Agent）** | `使用 **brainstorming** 技能…先了解项目上下文。` |
| 16:17:07.390 | `toolUse`（todowrite） | 紧跟 #1，间隔 13ms |
| 16:18:32.151 | 末段 `output` delta | canvas 文案结尾 `URL)` |
| **16:18:32.804** | **`message.created` #2（Agent）** | `Some of what we're working on might be easier…` |
| 16:18:32.805 | `statusChange` old=2 new=3 | Active → **Idle**，整轮结束 |

**结论（来自日志，非推测）：**

- 全程只有 **一次** Active→Idle，属于 **同一逻辑 turn**。
- Daemon 在该 turn 内广播了 **2 次** Agent `message.created`。
- 第一次发生在 **首段 output 结束 + 首个 toolUse 之前**；第二次在 **末段 output 结束 + Idle 之前**。

整段日志中 `message.created` 仅 3 条（1 用户 + 2 Agent），无第三次 Agent 消息。

---

## 2. 根因链（三层）

### 2.1 Daemon：`TurnAggregator` 在 tool 打断时 flush AgentReply

**位置:** `apps/daemon/src/runtime/turn_aggregator.rs`

每次 `ToolUse` 前会 `flush_reply_into`，把已积累的 `reply_buf` 写成一条 `MessageKind::AgentReply`，再经 `server.rs` `emit_agent_message` 发布为 MQTT `message.created`（仅非空 reply 会 `cloud_persistent`）。

这是 **有意设计**：单轮内可有多条 AgentReply 行，共享同一 `turn_id`。

**与本 bug 的关系：** 16:17:07 的 #1 即「首段文字 + todowrite」触发的 mid-turn flush。

### 2.2 Desktop：`pendingStreamReply` 中途 fallback flush 拆开 UI 流

**位置:** `packages/app/src/App.tsx`、`packages/app/src/lib/live-agent-stream.ts`

- `AGENT_REPLY` 的 `message.created` **不立即** `appendMessage`，进入 `pendingStreamRepliesRef`。
- `schedulePendingStreamReplyFallback` 在 `PENDING_AGENT_REPLY_FALLBACK_MS`（1.2s）与 `PENDING_AGENT_REPLY_TOOL_GRACE_MS`（3s）规则下可 **在 turn 未结束** 时调用 `flushPendingStreamReply`。
- 该 flush 会：`appendStreamReplyAfterPartsPersist`（第一条进 MessageList）→ `finishSessionActor` → `releaseActorAfterPersist`。
- 后续 `acp.event` 经 `v2-streaming-store` 的 `prepareMutation`：对已 **inactive** 的 entry **归档** 并 **新建空 stream**。

**与本 bug 的关系（图一「断层」）：**

- 16:17:07.377 收到 #1 → 启动 fallback 计时。
- 16:17:07.390 `toolUse`（todowrite）。
- 首条 todowrite `toolResult` 在 **16:17:10.145**（≈2.77s）。此后 `!hasActiveTool` 且 `elapsed ≥ 1.2s`，下一次定时器 tick（约 **16:17:10.9**）即可满足 `shouldFlushPendingAgentReplyFallback` — **不必** 等满 3s `toolGraceMs` 或 `hasTextAfterActiveTool`（见 `live-agent-stream.ts:238-255`、`live-agent-stream.test.ts`）。
- 中途 flush 调用顺序：`finishSessionActor` → `appendStreamReplyAfterPartsPersist` → `releaseActorAfterPersist`（`App.tsx:791-794`）。
- 归档有 **两条路径**：（1）`releaseActorAfterPersist` 直接写入 `archived`（`v2-streaming-store.ts:1023-1051`）；（2）后续 `acp.event` 命中 `prepareMutation` 时对 **inactive** entry 归档（566-576）。若 `persistedPartsCoverLiveArtifacts` 为 true，可能跳过（2）但不影响已落库的 MessageList 行。
- UI 同时存在：**MessageList 已落库气泡** + **bottomContent 里 archived/current 两个 `StreamingAgentBubble`** → 两个 MACMINI 头。

相关常量：`packages/app/src/lib/live-agent-stream.ts`  
`PENDING_AGENT_REPLY_FALLBACK_MS = 1200`，`PENDING_AGENT_REPLY_TOOL_GRACE_MS = 3000`，`PENDING_AGENT_REPLY_HARD_TIMEOUT_MS = 8000`。

**注：** 同 turn 在 16:16:56 已有 skill `toolUse`，但当时 `reply_buf` 为空，故无 `message.created`（与 `flush_reply_into` 仅非空才 emit 一致）。

### 2.3 Desktop：`adaptTeamclawMessages` canonical `parts_json` 覆盖前段正文

**位置:** `packages/app/src/lib/v2-message-adapter.ts` — `buildTurnSdkMessage`

同一 `(senderActorId, turnId)` 的多条 `AGENT_REPLY` 会合并为一条 SdkMessage。若 **最后一条** 带 `parts_json`，走 canonical 分支：

```ts
const canonicalReply = [...uniqueReplies].reverse().find((reply) => partsJson(reply));
// content: canonicalText || canonicalReply.content || replyText
```

**与本 bug 的关系（图二「只剩末段」）：**

- 中途 flush 为 msg1 写入 `parts_json`（第一段 + 早期 tool）。
- Turn 结束 flush 为 msg2 写入 `parts_json`（仅第二段 tool + canvas 文案）。
- canonical 选中 **msg2** → `content` / `parts` 以第二段为准 → 第一段「brainstorming…」在最终气泡中不可见。
- `replyText` 本可 `join("\n\n")` 两段，但被 `canonicalText` 优先覆盖。

已有测试 `uses persisted canonical parts_json for reload parity` 覆盖「多 reply + 单份完整 parts」；**未覆盖**「多 reply、各带 **不完整** parts_json」场景。

---

## 3. 责任边界

| 层级 | 行为 | 判定 |
|------|------|------|
| Daemon `TurnAggregator` | tool 前 flush → 多次 `AgentReply` | **按设计**，非 regression |
| Desktop `App.tsx` fallback flush | 单 turn 内多次落库 + 拆 stream | **与「整轮一条气泡」产品目标冲突** |
| `v2-message-adapter` | 多份 `parts_json` 时只吃最后一份 | **丢失前段正文的直接渲染原因** |

Streaming 展示仍应只跟 `acp.event`（`v2-streaming-store`），`message.created` 用于 turn 结束后的持久化对齐（见 `App.tsx` 注释与 iOS 对齐说明）。

---

## 4. 复现路线

1. 打开会话，@ 本地 Agent（如 MACMINI），模型 `deepseek/deepseek-v4-pro`。
2. 发送：`[using-superpowers] 写一个todo网站`（或任意会先输出短文字再调 tool 的 prompt）。
3. 观察 Agent 先流式输出一小段，再触发 **todowrite** 或其它 tool。
4. **图一：** 约 3s 内应出现 `live:message.created`（Agent #1）→ fallback flush → MessageList 一条 + 底部新 `StreamingAgentBubble` → **两个 MACMINI 头**。
5. 同一轮继续 tool/output 直至 Idle。
6. **图二：** 第二次 `message.created` + Idle flush → 合成一条 Agent 气泡，**正文以最后一段 `parts_json` 为主**，早期段落不显示。

**调试辅助：** `AcpStreamDebugPanel` / `acp-stream/<sessionId>.log` 中搜 `live:message.created`，同一 Active 段内应看到 ≥2 条 Agent 行。

---

## 5. 统一修复方案（单 PR，一把解决）

> **原则：** 不改 daemon（保留 mid-turn `message.created` 契约）；桌面端用 **「单 turn 单流式气泡 + 单轮结束一次落库 + 历史合并渲染」** 与 daemon 解耦。  
> **不做方案 C**，避免 iOS / 多客户端 / 云端审计行为变化。

### 5.1 目标不变量（修复后必须成立）

| # | 不变量 | 说明 |
|---|--------|------|
| I1 | 单 turn 流式 UI 只有一个 MACMINI 头 | `acp.event` 驱动期间不 `finishSessionActor` / `releaseActorAfterPersist` |
| I2 | 单 turn 结束 MessageList 只有 **一条** 合成 Agent 气泡 | `appendMessage` 每 `(sessionId, turnId, actorId)` 至多一次 |
| I3 | 合成气泡 `content` + `parts` 含 **整轮** 正文与 tool/thinking 顺序 | 含 mid-turn daemon 切片 + 末段 output |
| I4 | 流式阶段不 `ingestReplyPreview` | 保持现有 iOS 对齐注释 |
| I5 | MQTT 重复投递仍 dedupe | `rememberLiveEventId` 不变 |
| I6 | interrupt / discard pending 仍清空停车 | `registerDiscardPendingStreamReply` 不变 |

### 5.2 架构：三处改动，一条数据流

```
acp.event (整轮) ──► v2-streaming-store（唯一 live UI，不中途归档）
message.created (可多条) ──► pendingStreamRepliesRef（只停车，不 appendMessage）
flush 触发（见 §5.2.1，无固定秒数）──► flushTurnAgentReply（一次）──► persist parts_json ──► appendMessage ×1
                                                              └──► releaseActorAfterPersist ×1
reload / 本地 cache 多行 agent_reply ──► adaptTeamclawMessages（按 turn 合并 parts + 正文）
```

### 5.2.1 何时 flush（事件驱动，不用 8s / 3s 定时器）

**原则：** 落库时机跟 **轮次边界 / 运行时状态** 走，不跟 AI 供应商速度绑固定秒数。慢模型可以跑几分钟，期间只靠 `acp.event` 流式展示；**不因时钟** 把一轮拆成两条气泡。

| 优先级 | 触发条件 | 行为 |
|--------|----------|------|
| P0 | `statusChange` → Idle / Error / Stopped | **主路径**：`flushTurnAgentReply` |
| P0 | 已 P0 之后迟到的 `message.created`（`terminalFlushPendingRef`） | 立即补 flush（804/805ms 乱序） |
| P1 | `statusChange` Idle→**Active**（同 actor 新一轮） | 先 flush **上一轮** 该 actor 的 pending（防丢上一轮 Idle） |
| P1 | `acp.event` → `error` | 按终态 finish；有 pending 则 flush |
| P2 | 用户 **interrupt** | `discardPendingStreamReply`（现有逻辑，不落库半截） |
| P2 | **切换活跃会话**（`activeSessionId` 变化，可选） | 对离开会话上有 pending 的 actor flush 一次 |
| P3 | **MQTT 重连**后 `runtime/{id}/state` retain 已为 Idle，且本地仍有 pending | 补 flush（比猜秒数可靠） |
| P4（可选） | 异常挂机：长时间 **无任何** `acp.event` **且** runtime 已 Idle **且** pending 非空 | 可配置 **很长** 的无事件阈值（如 10–30min）；**默认可不实现**，流式 UI 已可见全文 |

**明确删除：**

- `PENDING_AGENT_REPLY_FALLBACK_MS`（1.2s）触发的 flush — 图一根因。
- `PENDING_AGENT_REPLY_TOOL_GRACE_MS`（3s）触发的 flush — 同上。
- **`PENDING_AGENT_REPLY_HARD_TIMEOUT_MS`（8s）** — 与供应商延迟无关，易误伤慢回复；**本方案不采用**。

**慢模型为何没问题：** 在收到 P0 之前，用户始终看 **同一个** `StreamingAgentBubble`；pending 只影响 MessageList/历史，不影响流式完整性。

### 5.3 具体改动（按文件）

#### （1）`live-agent-stream.ts` — 停车策略 + 合并语义

**A. 删除基于时间的 fallback flush**

- **移除** `schedulePendingStreamReplyFallback`、`shouldFlushPendingAgentReplyFallback` 及常量 `PENDING_AGENT_REPLY_*_MS`（或仅保留废弃注释一版，无调用方）。
- **不再** 为 `message.created` 启动任何 `setTimeout` 落库。
- 新增（可选）`shouldFlushPendingFromRuntimeIdle(runtimeInfo)`：读 `useRuntimeStateStore` 中该 actor 的 retain `status === Idle`，供 P3 使用。

**B. 修正 `mergePendingAgentReplies`（图二 + 优化）**

终端合并规则（按优先级）：

1. `streamEntry.outputText` 非空且 **覆盖** 所有 pending 正文（`agentReplyTextsEquivalent` 或 pending 每段均为 stream 子串）→ `content = outputText`。
2. 否则 → `content = joinDistinctPendingChunks(pending)`（保留现有去重逻辑），再与 `outputText` 用 `\n\n` 拼接 **仅当** output 含 pending 没有的新增尾部。
3. **禁止**「有 streamText 就只取 stream、丢弃 pending 前段」的当前行为（`live-agent-stream.ts:54-55`）。

新增单测：`mergePendingAgentReplies` — 两 pending 段 + 仅含末段的 `outputText` → 结果含两段。

#### （2）`App.tsx` — 终端一次 flush + 乱序兜底

**A. `flushPendingStreamReply` → `flushTurnAgentReply`（语义收紧）**

仅在 **§5.2.1** 所列事件路径调用（**无定时器**）：

- P0：`statusChange` terminal；
- P0：`terminalFlushPendingRef` + 迟到 `message.created`；
- P1：Idle→Active 时 flush **上一 turn** pending（按 `turnId` / 上一 stream 代际区分）；
- P1：`acp.event` error；
- P2/P3：interrupt 清 pending；切会话 / runtime Idle 补 flush（实现时二选一或都做）。

**禁止**在 parking 时调用 `finishSessionActor` / `releaseActorAfterPersist`。

**Ref 形态（每 `streamKey`）：**

```ts
pendingStreamRepliesRef
terminalFlushPendingRef   // P0 已发生，等待迟到 message.created
// 无 pendingStreamReplyTimersRef
```

终端 flush 顺序（固定，避免双归档）：

```
merged = mergePendingAgentReplies(pending, streamEntry)
persistStreamingPartsForReply(sessionId, actorId, merged)  // 用 **仍 active** 的 stream 建 parts
finishSessionActor(...)
replaceTurnAgentRepliesInStore(sessionId, turnId, actorId, merged)  // 见下
releaseActorAfterPersist(...)
clear pending + terminalFlushPendingRef
```

**B. `message.created`（AGENT_REPLY）处理**

- 继续只写入 `pendingStreamRepliesRef` + `upsertMessagesBatch`（本地 cache 可仍有多行，供 sync）。
- **不启动任何落库定时器。**
- **`markActorStreamActive` 调整：**
  - mid-turn、stream 仍 active：**不调用**（避免无意义重激活）。
  - `terminalFlushPendingRef` 已置位：收到 `message.created` → 直接 `flushTurnAgentReply()`，**不再** `markActorStreamActive`。
- **`statusChange` Idle→Active：** 在 `beginPlanningPlaceholder` 之前，对该 `actorId` 调用 `flushTurnAgentReplyIfPending`（P1，清上一轮停车）。

**C. `replaceTurnAgentRepliesInStore`（新辅助，放 `session-message-store` 或 `live-agent-stream`）**

```ts
// 伪代码
function replaceTurnAgentRepliesInStore(sessionId, turnId, actorId, merged: TeamclawMessage) {
  const cur = messages[sessionId] ?? [];
  const rest = cur.filter(m =>
    !(m.turnId === turnId && m.senderActorId === actorId && m.kind === AGENT_REPLY)
  );
  setMessages(sessionId, [...rest, merged]); // messageId = merged.messageId（取 pending 最后一条，与 cloud 对齐）
}
```

保证 I2：UI store 每 turn 一条 AgentReply，即使 cache/Supabase 仍有多行。

**D. interrupt / 切会话**

- `discardPendingStreamReply`：清除 `pending` + `terminalFlushPendingRef`（**无 timer**）。
- （可选）`activeSessionId` 切换 effect：对旧 session 执行 P2 flush，避免换会话后 pending 泄漏。

#### （3）`v2-message-adapter.ts` — 历史/重载合并（图二 reload 路径）

**`buildTurnSdkMessage` 调整：**

- 收集组内所有带 `partsJson` 的 `AGENT_REPLY`，按 `createdAt` / `sequence` 排序。
- 新增 `mergeTurnPartsJson(replies)`：按序拼接 reasoning / tool-call / text parts；tool 按 `toolCallId` 去重保留最新 status；text 段按序保留（不覆盖）。
- `content`：**始终** `uniqueReplies.map(r => r.content).join("\n\n")` 为主；仅当 **仅一条** reply 带完整 `parts_json` 且已含全部 text 时，才用 canonical 单条路径（兼容现有 `uses persisted canonical parts_json for reload parity` 测试）。
- `id`：优先 **最后一条** pending 的 `messageId`（与 terminal flush 一致）。

新增测试：`two replies with disjoint parts_json → one SdkMessage, both text segments, ordered tools`（对应 `8644132b` 场景）。

#### （4）`streaming-persist.ts` — 优化（随终端 flush）

- `buildCanonicalPartsFromEntry` 在 terminal flush 时读取 **未归档** 的完整 stream entry（I1 保证整条都在）。
- 可选：`persistStreamingPartsForReply` 写回后，对同 `turnId` 旧 `messageId` 的 cache 行 **更新** `parts_json` 指向 canonical（不删行，避免 sync 水印异常）；或仅依赖 adapter 合并 — **最小方案只做 adapter**，cache 多行可留。

#### （5）不改 daemon

- `TurnAggregator` mid-turn flush **保持**；桌面端用 I1–I3 消化多条 `message.created`。

### 5.4 明确不做的改动（降回归）

| 不做 | 原因 |
|------|------|
| 改 `TurnAggregator` / 减少 `message.created` | 多客户端契约、云端行数 |
| mid-turn `appendMessage` | 图一根因 |
| 依赖 `ingestReplyPreview` 补正文 | 已知 duplicate stream |
| 删除 `upsertMessagesBatch` | 会破坏 delta sync / 重连对账 |
| 改 `prepareMutation` 归档语义 | 影响多 turn 历史展示；I1 下 mid-turn 不触发即可 |
| 固定 8s / 3s / 1.2s 落库定时器 | 与供应商速度无关，导致图一或误截断 |

### 5.5 回归矩阵（改前必须过）

| 场景 | 期望 | 覆盖方式 |
|------|------|----------|
| `8644132b` 复现路径 | 单流式头；结束后两段正文都在 | 手动 + adapter 单测 |
| tool-only turn（无 output 仅有 tool） | Idle 后仍有一条 Agent 气泡（可空 content + tools in parts） | 现有 `tool_only_turn` daemon 测 + adapter |
| 慢模型长 turn（数分钟才有 Idle） | 全程单流式头；**不因计时器** mid-flush；Idle 后一次落库 | 手动 / 单测 mock 长间隔 acp.event |
| 丢 terminal `statusChange`、下一轮用户再 @ | P1 Idle→Active 时补 flush 上一轮 | 新单测 |
| 丢 terminal、runtime retain 已 Idle | P3 补 flush（若实现） | 单测 + 手动 |
| interrupt | pending 清空，无幽灵气泡 | `interrupt-agent` 路径 / 单测 |
| MQTT 重复 `message.created` | `appendMessage` 不重复 | `rememberLiveEventId` + store dedupe |
| statusChange 先于最后 `message.created` | 迟到消息触发 fast flush，内容完整 | 新单测：先 terminal flag，再 park #2 |
| 重载会话（cache 2 行 agent_reply 同 turn） | 仍 1 条 SdkMessage 全文 | adapter 新测 |
| permission / doom_loop | 流式条不消失 | 现有 E2E/smoke（若有）或手动 |
| 多 turn 连续对话 | 上一 turn archived 流仍可显示 | 不动 `prepareMutation`；仅 turn 间归档 |

### 5.6 实施与验证（单 PR）

**建议分支：** `fix/agent-reply-single-turn-flush`

**文件清单：**

1. `packages/app/src/lib/live-agent-stream.ts`
2. `packages/app/src/App.tsx`
3. `packages/app/src/lib/v2-message-adapter.ts`
4. `packages/app/src/stores/session-message-store.ts`（`replaceTurnAgentRepliesInStore`）
5. `packages/app/src/lib/__tests__/live-agent-stream.test.ts`
6. `packages/app/src/lib/__tests__/v2-message-adapter.test.ts`
7. （可选）`packages/app/src/lib/streaming-persist.ts` 小改

**命令：**

```bash
pnpm test:unit -- packages/app/src/lib/__tests__/live-agent-stream.test.ts \
  packages/app/src/lib/__tests__/v2-message-adapter.test.ts \
  packages/app/src/lib/__tests__/duplicate-agent-reply-render.test.ts
pnpm typecheck
```

**手动：** 按 §4 复现；确认 `acp-stream` 仍可有 2 条 `message.created`，但 UI 仅 1 气泡且含 brainstorming + canvas 段。

### 5.7 与原 A/B/C 方案对照

| 原方案 | 统一方案中的归宿 |
|--------|------------------|
| A 禁止 mid-turn flush | §5.2.1 事件驱动 flush + §5.3 删除全部定时 fallback |
| B 合并 parts/content | §5.3(1) merge + §5.3(3) adapter + §5.3(2) replaceTurn |
| C 改 daemon | **明确不做** |

---

## 6. 验证清单（修复后）

- [ ] **I1** 单 turn 内仅一个 MACMINI 流式头（无 mid-turn archived/current 双气泡）。
- [ ] **I2** MessageList 每 turn 仅一条 `AGENT_REPLY`（store 层）。
- [ ] **I3** 合成 `content` 含 brainstorming 段 + canvas 段；`parts` 含中间 tool 顺序。
- [ ] 日志仍可有多次 `message.created`；UI/DB 表现与 daemon 解耦。
- [ ] §5.5 回归矩阵全部通过。
- [ ] `pnpm test:unit` + `pnpm typecheck` 通过。

---

## 7. 相关文件索引

| 文件 | 角色 |
|------|------|
| `apps/daemon/src/runtime/turn_aggregator.rs` | mid-turn AgentReply flush |
| `apps/daemon/src/daemon/server.rs` | `emit_agent_message` / MQTT |
| `packages/app/src/App.tsx` | `pendingStreamRepliesRef`、fallback、statusChange flush |
| `packages/app/src/lib/live-agent-stream.ts` | merge / flush 触发（事件驱动，无定时器） |
| `packages/app/src/stores/runtime-state-store.ts` | P3：retain Idle 补 flush（可选） |
| `packages/app/src/stores/v2-streaming-store.ts` | `prepareMutation` 归档 |
| `packages/app/src/lib/streaming-persist.ts` | `parts_json` 写入 |
| `packages/app/src/lib/v2-message-adapter.ts` | turn 分组合并渲染 |
| `packages/app/src/components/chat/ChatPanel.tsx` | `displayV2Streams` + MessageList |

---

## 8. 交叉评审摘要（Subagent，2026-06-05）

**结论：** **PARTIALLY CONFIRMED** — 主链条成立；claim 6/7 机制表述已按评审修正（见 §2.2）。

| 主张 | 评审 |
|------|------|
| 单 turn、双 Agent `message.created`、TurnAggregator、pending 停车、canonical 丢字 | ✅ |
| fallback 必等满 3s | ⚠️ 已修正：tool 完成后 ≥1.2s 即可 |
| 归档仅经 `prepareMutation` | ⚠️ 已修正：含 `releaseActorAfterPersist` |
| 原 A→B→C 分 PR | 已合并为 §5 单 PR（不做 C） |

**补充风险（评审提出）：** 停车期间仍 `upsertMessagesBatch`（`App.tsx:1039-1079`），本地 DB 可有 2 行 `agent_reply`；终端 `statusChange` flush 与 #2 `message.created` 几乎同时（804ms vs 805ms），需防重复 append；方案 A 需与 `markActorStreamActive` 一并验证。

---

## 9. 修订记录

| 日期 | 作者 | 说明 |
|------|------|------|
| 2026-06-05 | Composer 2.5 Fast | 初版：基于 `8644132b` 完整 acp-stream 日志 + 代码路径 |
| 2026-06-05 | Composer 2.5 Fast + Subagent review | 修正 fallback/归档表述；增加 §8 交叉评审 |
| 2026-06-05 | Composer 2.5 Fast | §5 重写为统一单 PR 方案（含优化项 + 回归矩阵） |
| 2026-06-05 | Composer 2.5 Fast | §5.2.1：flush 改为事件驱动，移除 8s/3s/1.2s 定时落库 |

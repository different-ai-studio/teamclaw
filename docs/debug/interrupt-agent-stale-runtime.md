# Agent 中断偶发失效 — 根因调查

**现象:** 用户点击 Composer 停止按钮后，agent 仍在输出；偶发，无 toast。  
**调查日期:** 2026-07-02  
**状态:** 已修复（分支 `fix/stale-runtime-interrupt`）  
**环境:** `teamclaw-dev`（`api.teamclaw-dev.ucar.cc`），本地 MACPRO daemon（`01fbb592-8e52-4505-8e13-9ae86d2bc4d4`）

---

## 1. 结论（一句话）

**中断时 `runtime_id` 解析到了已死的 DB spawn，MQTT cancel 发到错误 topic，daemon 找不到 agent 后静默失败；UI 继续等 `statusChange: Idle`，用户感知为「按钮不好使」。**

---

## 2. 完整链路

```
用户点停止
  → interruptAgentActor()
  → GET /v1/sessions/:id/runtime-targets  （agent_runtimes 表）
  → resolvePermissionCommandTarget()      （DB session row 优先于 MQTT retain）
  → MQTT publish AcpCancel
       amux/{team}/{agentActorId}/runtime/{runtimeId}/commands
  → 远端 / 本地 daemon handle_agent_command(runtime_id, …)
  → cancel_agent(runtime_id)              （按 spawn id 查 RuntimeManager）
  → 成功 → statusChange Idle → 客户端结束流式
  → 失败 → 仅 warn 日志，无客户端回执
```

相关代码：

| 环节 | 文件 |
|------|------|
| 中断入口 | `packages/app/src/lib/teamclaw/interrupt-agent.ts` |
| runtime 解析 | `packages/app/src/lib/runtime-state-resolve.ts` → `resolvePermissionCommandTarget` |
| DB 查询 | `services/fc/src/lib/supabase-repo.ts` → `listRuntimeTargetsForSession` |
| MQTT cancel | `packages/app/src/lib/teamclaw/runtime-command.ts` → `sendCancel` |
| daemon 执行 | `apps/daemon/src/daemon/server/rpc.rs` → `Cancel` 分支 |
| daemon 查找 | `apps/daemon/src/runtime/manager/cancel.rs` → `cancel_agent` |

---

## 3. 根因（两层）

### 3.1 API 层：`runtime-targets` 可能返回 stale spawn

`listRuntimeTargetsForSession` 对 `agent_runtimes` 做等值查询，**无 `ORDER BY updated_at`**，同一 `(session_id, agent_id)` 存在多行时返回行不确定：

```typescript
// services/fc/src/lib/supabase-repo.ts
.from("agent_runtimes")
.select("agent_id, runtime_id")
.eq("session_id", sessionId)
.in("agent_id", agentIds);
```

Agent respawn / lazy-resume 后，旧 spawn 行仍留在表中，新 spawn 行后写入；API 仍可能返回旧 `runtime_id`。

### 3.2 客户端层：DB row 优先于 MQTT live retain

`resolvePermissionCommandTarget` 在 session 有 DB 行时 **直接使用** `sessionRuntimeRows[].runtime_id`，仅在无 DB 行时才 fallback 到 MQTT retain：

```typescript
// packages/app/src/lib/runtime-state-resolve.ts
const sessionRuntimeId = sessionRow?.runtime_id?.trim();
if (sessionRuntimeId) {
  return { actorId: trimmedAgent, runtimeId };
}
// 仅无 DB 行时 → resolveRuntimeStateEntryForAgent(...)
```

因此：**流式事件来自 live spawn（MQTT），cancel 却发往 DB 里的 dead spawn**。

### 3.3 Daemon 层：cancel 失败无回执

```rust
// apps/daemon/src/daemon/server/rpc.rs
Err(e) => {
    warn!(agent_id, "failed to cancel agent: {}", e);
    // 无 NACK / 无 MQTT 事件回传客户端
}
```

客户端 `interruptAgentActor` 在 `sendCancel` 成功后仅 `markInterruptedFlushPending`，**不清理本地流**；若 daemon 未变 Idle，UI 保持「正在回复」。

---

## 4. 实证（2026-07-02，MACPRO dev）

### 4.1 本地 daemon：同一 cloud session 双 spawn

`~/.amuxd/sessions.toml`，session `dd24052b-369f-4b01-9765-81ffbb449c19`：

| runtime_id | status | 含义 |
|------------|--------|------|
| `fd198a11` | 5 (Stopped) | 已死 spawn |
| `347049d7` | 2 (Active) | 当前 live spawn |

说明 respawn 后旧 runtime 仍残留在 daemon 持久化状态中。

### 4.2 Cloud API：DB 返回 stale `runtime_id`（实锤）

Session `9b1d64c4-ae82-4586-ae29-399c607a7a95`（标题 MACPRO 18:18），`agent_runtimes` 共 5 行：

| runtime_id | status | updated_at |
|------------|--------|------------|
| `0637c1e1` | idle | 2026-07-01 |
| `3738f30f` | starting | 2026-07-01 |
| `b650778a` | idle | 2026-07-01 |
| **`fd63c602`** | **running** | **2026-06-28** |
| `43012e3f` | starting | 2026-06-27 |

`GET /v1/sessions/9b1d64c4-…/runtime-targets?agentId=01fbb592-…` 返回：

```json
{ "agent_id": "01fbb592-…", "runtime_id": "fd63c602" }
```

较新的 running/starting spawn 为 `3738f30f`，与 API 返回值 **不一致**。

中断将发布到：

```
amux/68c9c97a-…/01fbb592-…/runtime/fd63c602/commands
```

若 agent 实际跑在 `3738f30f` → `cancel_agent("fd63c602")` → `agent fd63c602 not found` → 静默失败。

### 4.3 对照：无 mismatch 的 session

Session `0f0ce88b-cb1f-4bd3-8599-a441ae3353c8`：

- `runtime-targets` → `9a7015b0`
- 本地 daemon active spawn → `9a7015b0`
- **一致**，中断路径正常。

### 4.4 MQTT cancel 探针

已向 stale / live topic 成功 publish `AcpCancel`（MQTT QoS 1）。当前 amuxd 进程未写入 `~/.amuxd/amuxd.out.log`（日志止于 2026-07-01），无法在本地日志中捕获 cancel 回执；不影响 API 层 mismatch 结论。

---

## 5. 偶发条件

| 条件 | 说明 |
|------|------|
| Agent respawn | lazy-resume、daemon 重启、crash 恢复后换新 spawn id |
| 多行 `agent_runtimes` | 同 session+agent 存在多条历史行 |
| 流式仍正常 | 事件来自 live spawn；仅 cancel 路径用错 id |
| 远端 agent | 如 wuxing-mac；需在托管机器上对比 DB vs live spawn |
| 长耗时 tool | curl/bash 期间 ACP cancel 延迟；叠加后更像「点了没停」 |

**不触发 DB stale 路径的情况：** session 无 `agent_runtimes` 行 → fallback MQTT retain（通常正确）。  
**会直接 toast 的情况：** runtime 完全解析不到、MQTT publish 抛错。

---

## 6. 实锤公式

在复现会话上同时满足：

1. `interrupt.begin.runtimeId`（或 `runtime-targets` 返回值）≠ MQTT live retain 的 `info.runtimeId`
2. 同一 session 在 `agent_runtimes` / `sessions.toml` 存在多个 `runtime_id`
3. （可选）daemon 日志：`failed to cancel agent` / `agent {id} not found`

---

## 7. 修复实施（2026-07-02，分支 `fix/stale-runtime-interrupt`）

| Phase | 内容 | 文件 |
|-------|------|------|
| 0 | `listRuntimeTargetsForSession`：`ORDER BY updated_at DESC` + 每 agent 去重（**不用** cloud `status` 过滤；Composer stop 仅 Cancel→Idle，同 runtime 可继续对话）；`agentIds=[]` 返回 session 内全部 agent | `services/fc/src/lib/pg-repo/runtime.ts`, `supabase-repo.ts` |
| 1 | 抽取 `resolveCommandRuntimeId`：按 `RuntimeLifecycle` state 判 live；session 安全校验防跨 session 串台 | `packages/app/src/lib/runtime-state-resolve.ts` |
| 2 | `sessions.toml` spawn 时 `supersede_stale_for_session` 单行化 | `apps/daemon/src/config/session_store.rs`, `runtime_lifecycle.rs` |

**Cloud `status` 语义（勿混用）：**
- Composer **停止/中断** → daemon `Cancel` → 本地 **Idle**，云端通常 **idle**；**同一 `runtime_id` 仍可继续对话**。
- **进程终止 / supersede** → 本地 **Stopped**（MQTT retain）；**不写** cloud `stopped`（main 行为保持；cloud status 不参与路由）。
- **路由真相**：FC `updated_at` 最新行（hint）+ 客户端 MQTT `RuntimeLifecycle.state`（live 真相）；DB hint 在 MQTT 已 STOPPED 时不 blind fallback。

**未实施（可选 follow-up）：** Cancel 迁移 RPC + NACK（Phase 3）、`RuntimeInfo.session_id` proto 字段。

**Review 跟进（2026-07-02）：**
- 撤掉 Phase 2b（cloud `stopped` 回写）及 FC stopped 专用 upsert — 与 interrupt 无关，且 cloud 几乎无 `stopped` 行
- 客户端 `resolveCommandRuntimeId`：DB hint 在 MQTT 已 dead 时改选同 agent 的 live retain
- 客户端 `resolveCommandRuntimeId` 第三层 fallback 增加 `sessionSafe` 约束，避免无 DB 行时跨 session 误发

### 自动化验证

```bash
cd services/fc && node --import tsx --test test/pg-repo-runtime.test.ts
cd packages/app && pnpm exec vitest run src/lib/__tests__/runtime-state-resolve.test.ts src/lib/__tests__/interrupt-agent.test.ts
cargo test -p amuxd config::session_store::tests --manifest-path apps/daemon/Cargo.toml
```

### 手工验证（FC 部署后）

1. 对存在多行 `agent_runtimes` 的 session 调 `runtime-targets`，确认返回最新 `runtime_id`
2. 流式输出中点停止，MQTT topic 中 `runtimeId` 与 live retain 一致
3. permission grant/deny、setModel 回归

---

## 8. 复现 / 诊断命令

```bash
# 1. 查 cloud runtime-targets vs 全量 runtime 行
# （需有效 refresh token，见 ~/.amuxd/backend.toml）

# 2. 查本地 daemon 双 spawn
grep -A6 'session_id = "<SESSION_UUID>"' ~/.amuxd/sessions.toml

# 3. DevTools
# 过滤 [session-flow] interrupt.begin / interrupt.ok
# 或 interrupt-msg-diag → window.teamclawInterruptMsgDiagDump?.()

# 4. daemon 日志（若写入）
rg 'failed to cancel|agent cancelled via ACP' ~/.amuxd/amuxd.out.log
```

---

## 9. 关联

- 用户反馈场景：远端 wuxing-mac agent + 长耗时 curl tool + Composer 停止按钮无反应。
- 类似调查文档格式：`docs/debug/agent-reply-split-turn-8644132b.md`
- 测试用例占位：`docs/testing/plans/2026-06-02-beta-p0-automation-phase1.md`（D3 interrupt deferred）

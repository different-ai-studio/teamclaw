# iOS 废除 Runtime 概念 —— 迁移计划

**范围**：`apps/ios/`，外加 `apps/daemon/` 两处寻址修复。
**不改 proto 契约**，因此桌面端 wire 不受影响。

**前置阅读**：ADR-0002 / 0003 / 0004 / 0005，
[`docs/plans/2026-08-03-runtime-removal-migration-plan.md`](./2026-08-03-runtime-removal-migration-plan.md)
（本文是它阶段 7 里「阻塞于 iOS」那一项的展开）。

## 起因

上一轮迁移把 iOS 排除在外，前提是**旧路径保留作为 iOS 兼容层**。这个前提在写下的
当天与次日就被打破了，但两处都没人更新文档：

| 日期 | commit | 动作 | iOS 实际状态 |
|---|---|---|---|
| 8/3 | `657de72e` | `DROP TABLE agent_runtimes CASCADE` | 只换了 participants loader |
| 8/4 | `1b5a25ee` | 停发 `runtime/{id}/state` retain | 仍在订阅这个死 topic |

`services/supabase/migrations/20260803010000_drop_agent_runtimes.sql` 的注释写着
「the daemon, desktop and **iOS all moved in the same change set**」——iOS 并没有。
它只完成了 ADR-0005 的读 participants 那一半，模型目录与寻址那一半从未动过。

**结果**：`SessionMemberSheetLoader` 只能硬编码 `runtimeID: nil`，而 iOS 全部模型
功能（读与写、member sheet 与 composer 两个选择器）都以 `runtimeID` 为唯一键，
于是 agent 的模型既看不到也选不了。这是当前已知的最直接症状，但不是唯一后果——
第 4 节列出的 8 项 UI 功能都还挂在同一个悬空概念上。

上一轮计划文档中两处已失效的断言，一并在阶段 6 更正：

- L37「iOS 在阶段 7 前一直打 `GET /v1/runtime`，这是它唯一的保护」——iOS 现已不调用
  任何 runtime REST 端点
- L82「旧的 `runtime/{rid}/state` 继续发」——已停发

## 目标状态

iOS 只认一个真相源：`amux/{team}/{actor}/state` 上的 `ActorPresence`。

| 原 | 新 | 键 |
|---|---|---|
| SwiftData `Runtime` @Model | `AgentAttachment`（ADR-0004 词汇） | `{actorID}::{sessionID}` |
| `runtimeID` 标识符 | 废除 | — |
| `runtime/+/state` 订阅 | 废除 | — |
| `RuntimeResolver` | 废除 | — |
| 模型目录来自 `RuntimeInfo.available_models` | `catalog_models[worktrees[w].model_indices[]]` | 按 `live.worktree` 对齐 |

**iOS 尚未正式发布，无兼容窗口**——不做双轨、不留 deprecated shim、不做数据迁移
（`AMUXModelContainer` 迁移失败即重建 store，见 `AMUXModelContainer.swift:6-18`）。

---

## 阶段 0 — daemon：两个 RPC handler 补上寻址解析

**这是 iOS 能干净删除 `runtimeID` 的唯一前提。** 无 proto 改动。

`resolve_command_agent_id`（`apps/daemon/src/runtime/manager/lookup.rs:122-157`）
**已经支持 iOS 的 `{actor}::{session}` 复合寻址**（L137-153，`manager.rs:2465-2515`
有 4 个单测覆盖），但全仓只有 `rpc.rs:170` 一个生产调用者。以下两处绕过了它，
直接裸查按 spawn-key 键控的 `agents` map：

- [ ] `handle_set_model`（`daemon/server/runtime_lifecycle.rs:900-913`）
      → `agents.set_model(&runtime_id, …)` → `model_apply.rs:78` 的 `self.agents.get()`
- [ ] `handle_stop_runtime`（`daemon/server/runtime_lifecycle.rs:771-794`）
      → `get_handle(&runtime_id)` + `stop_runtime(&runtime_id)`

照 `rpc.rs:163-181` 的现成模式改，`request.requester_actor_id` 在两个 handler 里都已可用：

```rust
let resolve_actor = request.requester_actor_id.trim();
let resolved = {
    let agents = self.agents.lock().await;
    agents.resolve_command_agent_id(&runtime_id, resolve_actor)
};
let Some(agent_id) = resolved else {
    return reject_set_model(request, "no attachment for address");
};
// 之后一律用 agent_id，不再用 runtime_id
```

- [ ] 顺带改掉 `model_apply.rs:17-20` 那句「retained `runtime/{id}/state` reflects the
      request」——该 topic 已停发
- [ ] 补测试：`{actor}::{session}` 与裸 `session_id` 两种寻址都能 setModel / stop

**副作用（正面）**：桌面端目前把 `session_id` 当 `runtime_id` 发
（`runtime-state-store.ts:311-335`），本阶段一并修好，无需改桌面端代码。

## 阶段 1 — 重新生成 iOS protobuf

`amux.pb.swift` 落后于 `proto/amux.proto`，缺的正是 `1b5a25ee` 为解决多 checkout
设备而加的字段：

- [ ] `LiveSession.worktree = 10`（`proto/amux.proto:409`）—— iOS 侧字段停在 `current_model`(9)
- [ ] `ActorPresence.default_workspace_id = 9` / `default_worktree = 10` /
      `default_workspace_models = 11`（`proto/amux.proto:364-371`）

仓库内**没有任何 Swift protobuf 生成脚本**（`.pb.swift` 是手工 `protoc` 产物后
commit 进来的，仅 3 次提交，无自动化痕迹）。这正是漂移的成因。

- [ ] 生成（`--swift_opt=Visibility=Public` 由现产物反推）：
      ```
      protoc -I proto \
        --swift_out=apps/ios/Packages/AMUXCore/Sources/AMUXCore/Proto \
        --swift_opt=Visibility=Public \
        proto/amux.proto proto/teamclaw.proto
      ```
- [ ] **把这条命令固化成 `package.json` 的 `proto-gen:ios`**（与既有的 `proto-gen`
      并列），否则下次改 proto 又会静默漂移
- [ ] 考虑加一个 CI 检查：重新生成后 `git diff --exit-code`

## 阶段 2 — 删死代码（零风险，可先行合入）

均已确认无生产调用者：

- [ ] `AMUXSharedUI/AgentStatusPill.swift` —— 整文件
- [ ] `SessionDetailView.swift:55-72` 的 `init(runtime:)` —— 两个调用点都用 `init(session:)`
- [ ] `CloudAPI/CloudAPIRepositories.swift:884-897` 的 `CloudAgentRuntime` struct
- [ ] `MQTTTopics.swift:55-57` `runtimeStatePrefix` / `:63-65` `runtimeCommandsWildcard`

## 阶段 3 — 切数据源：`Runtime` → `AgentAttachment`

当前 `syncActorPresence`（`SessionListViewModel.swift:530-586`）把 `ActorPresence`
**投影成 `Amux_RuntimeInfo` 再喂 `syncRuntime`**——这层桥接是过渡产物，直接去掉。

- [ ] 新建 `AgentAttachment` @Model，主键 `{actorID}::{sessionID}`。按 ADR-0004
      「后续影响」删掉这些字段：`sessionTitle`（与 `sessions.title` 重复）、
      `currentPrompt` / `lastOutputSummary` / `toolUseCount` / `startedAt`
      （只在离散 lifecycle 事件时快照，中间不更新）
- [ ] **目录解析按 worktree 对齐**，删掉 `:538` 那个猜测：
      ```swift
      // 现状（多 checkout 设备直接拿到空模型列表）
      let soleCatalog = presence.worktrees.count == 1 ? presence.worktrees.first : nil
      // 目标（对标 packages/app 的 projectActorPresence）
      let catalogByWorktree = Dictionary(uniqueKeysWithValues:
          presence.worktrees.map { ($0.worktree, $0) })
      let wt = catalogByWorktree[live.worktree]
      let models = wt?.modelIndices.compactMap { presence.catalogModels[safe: Int($0)] } ?? []
      ```
- [ ] 冷 / 草稿态（session 不在 `live_sessions` 里）回落 `default_workspace_models`。
      **`live_sessions` 里没有 = 冷，下次发消息会 spawn，不是查询失败**
- [ ] 删除旧腿：`SessionListViewModel.swift:372,384` 的 `runtimeStateWildcard` 订阅/退订、
      `:424-435` `parseRuntimeStateTopic`、`:87` hub 谓词的对应分支、`:134-144` 消息分支、
      `:437-518` `syncRuntime`
- [ ] 删除 `SessionDetailViewModel.swift:866-891` `subscribeToSessionAgentRuntimeStates`
      与 `:1720` 的对应退订

## 阶段 4 — 读端逐项迁移

`Runtime` 删掉后受影响的 8 项功能，逐项换源：

| 功能 | 现取值 | 新来源 |
|---|---|---|
| Agent chip 状态 | `Runtime.status` (Int 1..5)，`chipStateFromRuntime` `SessionDetailViewModel.swift:820-828` | `LiveSession.status` / `.lifecycle` |
| Slash commands | `Runtime.availableCommandsJSON`（`:750,848,1533` seed） | `WorktreeCatalog.available_commands` |
| 模型显示名 | `Runtime.availableModels` 按 id 找 displayName（`AgentEvent.swift:63-70`） | attachment 的 catalog |
| Restart runtime | `runtimeID(forAgentActorID:)` → stop，再 `agent.workspaceID`+`backendType` → start（`:1088-1151`） | 地址改 `{actor}::{session}`；`backendType` 改用 `ActorPresence.active_agent_type` |
| Remove agent | `runtimeStopRpc(targetActorID:runtimeID:)`（`:1319-1362`） | 同上 |
| Workspace 名 | `Runtime.workspaceId`（`SessionListHelpers.swift:319-322`、`SearchTab.swift:134-137`） | participant row 的 `workspaceID`（已有） |
| Session resume | `runtime?.status` ∈ {3,4,5} 跳过恢复（`:3022-3033`） | `LiveSession.lifecycle` |
| Session list 行 | `Runtime.hasUnread` / `.status` / `.agentType`（`SessionListHelpers.swift:364-415`） | attachment 对应字段 |

**event bucket key 是最大的一块**（`SessionDetailViewModel.swift:1897-1997`、
`Timeline/TimelineInput.swift`、`TimelineInputBuilder.swift`）：acp 事件的身份是
`(runtimeID, envelopeSequence)`，且有 `relabelRawRuntimeIDStampsToActorIDs()` 把已
落库的 raw runtime_id 戳改写成 actor_id。

- [ ] daemon 发出的 envelope 里 `runtime_id` 现在装的是什么？**动手前先确认**——
      若已是 session/复合地址，则 relabel 整套（`:1962-1997`）可直接删除；否则
      bucket key 改用 actor_id，relabel 保留但简化

- [ ] 模型解析收敛成**单一入口**（对标桌面端 `runtime-state-resolve.ts:495-586`
      的 `selectAgentModel`），优先级：
      `用户 pick > transcript 已确立 > retain currentModel > worktree default_model > available[0]`
- [ ] **retain 到达不得覆盖用户 pick** —— 桌面端踩过「模型弹回」这个坑，
      见 `agent-model-pick-store.ts:4-28` 的设计契约
- [ ] **不要自造本地 MRU** —— 那归 daemon 的 `config::model_mru`，经
      `WorktreeCatalog.default_model` 回来
- [ ] 写入路径顺序：`ensureParticipant → runtimeStart → setModel`
      （`ensure-agent-runtime.ts:244-316`）。注意 `runtimeStartRpc` 的返回值
      `runtimeID` 目前被丢弃（`TeamclawService.swift:1279`）

## 阶段 5 — 删除 Runtime 本体

- [ ] `Models/Runtime.swift` 整文件
- [ ] `Runtimes/RuntimeResolver.swift` 整文件（3 个调用点：`SessionDetailViewModel.swift:319-325,734,1523`）
- [ ] `SessionDetailViewModel.swift:1379-1381` `runtimeID(forAgentActorID:)` 及 6 个调用点
- [ ] `MemberSheetAgent.runtimeID` / `backendType`（`SessionMemberSheetLoader.swift:32,42`）
- [ ] `AMUXSchema.swift:17` 的 `Runtime.self`，并 **bump `versionIdentifier`**（现 `1.15.0`，`:13`）
- [ ] `AppOnboardingCoordinator.swift:473` 的 `delete(model: Runtime.self)`

## 阶段 6 — 测试与文档

三个文件会硬编译失败，直接重写或删除：

- [ ] `RuntimeResolverTests.swift`（6 test）—— 随 `RuntimeResolver` 整文件删除
- [ ] `SessionDetailViewModelTests.swift`（6 test）—— `Runtime.self` 进 schema、
      placeholder 语义
- [ ] `SessionDetailViewModelRelabelTests.swift`（8 test）—— 取决于阶段 4 relabel 的去留

需改断言语义的（按影响面排序）：`ChatTimelineReducerTests`、
`SessionMemberSheetLoaderTests`、`SessionDetailAvailableModelsTests`、
`StreamingRestoreAndTimerTests`、`RuntimeCommandSenderTests`、
`SessionDetailViewModelChipTests`、`TimelineInputTests` / `TimelineInputBuilderTests`、
`MQTTTopicsTests`、`ActorStateTopicTests`、`BuildFeedItemsTurnCollapseTests`、
`InterruptSemanticsTests`、`SessionDetailModelSwitchTests`。

`RuntimeStartRpcTests` 签名不变，基本可保留。
`apps/ios/AMUXUITests/` 无需改动（其中 `runtime` 全是变量命名，与本概念无关）。

- [ ] 更正 `docs/plans/2026-08-03-runtime-removal-migration-plan.md` 的 L37 / L82，
      并把 L134 依赖图里「阶段 7 阻塞于 iOS 迁移」指向本文
- [ ] `apps/ios/CONTEXT.md` 术语表同步 AgentHost / Attachment

## 阶段 7 — 收尾

- [ ] 删 `services/fc/src/lib/pg-repo/runtime.ts`（表已 DROP，整个 repo 模块悬空）
- [ ] 清理 daemon 侧死代码岛：`mqtt/publisher.rs:49-101` 的
      `publish_runtime_state` / `clear_runtime_state` / `publish_runtime_failed`
      （最后一个全仓 0 调用者），及 `crates/teamclaw-types/src/mqtt.rs:45-51` 的
      `runtime_state()` / `runtime_events()`
- [ ] `apps/daemon/src/runtime/handle.rs:78-83` 的 `backend_runtime_row_id` 及其
      指向已删函数的 `TODO(task9)`
- [ ] ADR-0004 未竟项：`RuntimeManager.agents` 改按 `session_id` 键控（阶段 3a），
      做完后阶段 0 的解析器可退化为直查

---

## 依赖图

| 阶段 | 阻塞于 |
|---|---|
| 0 daemon 寻址 | — |
| 1 重新生成 proto | — |
| 2 删死代码 | — |
| 3 切数据源 | 1 |
| 4 读端迁移 | 3、0（写入路径部分） |
| 5 删 Runtime | 4 |
| 6 测试文档 | 5 |
| 7 收尾 | 6 |

0、1、2 互不依赖，可并行开工。**阶段 0 和 1 是真正的解锁项**——两者都不做，
后面全是空转。

## 风险

- **阶段 4 的 event bucket 是最大不确定项**，涉及 timeline 身份与去重。动手前先
  确认 daemon envelope 里 `runtime_id` 的实际内容，不要靠推断。
- **schema version bump 会触发 store 重建**，本地缓存的 session/message 会丢一次。
  iOS 未发布，可接受；但要确认重建后首屏能从 Cloud API 正常回填。
- `AMUXCore` 的单测在改动模块图规模时容易撞出无关红灯（见既往经验），
  出现红灯先单独跑 + 重跑 + 干净 worktree 三步定性，别急着归因到本次改动。

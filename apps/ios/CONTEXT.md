# iOS Context

iOS 客户端（`apps/ios/AMUXApp/` + `apps/ios/Packages/AMUXCore/`）的领域语言。
Actor/Session/Workspace 等跨端实体引用 [proto CONTEXT](../../proto/CONTEXT.md)，此处仅定义 iOS 端独有的概念。

视觉与 SwiftUI 实现规范见 `apps/ios/DESIGN.md`（Hai 灰 / wabi-sabi）。

## Glossary

### OutboxMessage
**本地先入库再发送**的消息队列项。
当用户点击发送，先持久化为 SwiftData `@Model OutboxMessage`，再由 `OutboxSender` 后台 loop 推送至 MQTT + Supabase。
状态机 `OutboxState`：`pending → inFlight → delivered`，失败回 `pending` 带退避；超过 `maxAttempts` 落 `failed` 等用户手动重试。
应用被杀掉后重启 sender 可断点续传。
是 iOS 端 chat 可靠投递的核心模式 —— desktop / Expo 应 port 此架构。

### dedup key
[OutboxMessage](#outboxmessage) 在 publish 时携带的**幂等键**，由 iOS 生成、daemon 使用。
应用崩溃后重发同一条消息时，daemon 据此识别为重复，不再二次入库或转发给 Runtime。
保障"至少一次发送"在 daemon 侧收敛为"恰好一次"。

### Timeline
chat 视图的**渲染数据结构层**。
- `TimelineEntry` —— 时间线一条目（消息、permission 请求、tool call 等）
- `TimelineState` —— 一个 session 的完整时间线快照
- `ChatTimelineReducer` —— 把 `TimelineInput`（AcpInput / LiveMessageInput / HistoryInput / LocalPromptInput / PermissionResolutionInput）规约成新 TimelineState
- `TimelineSwiftDataSync` —— 持久化到 SwiftData

区别于 daemon 的 [Turn](../../proto/CONTEXT.md#turn)（一次 ACP 往返）—— Timeline 是渲染视图，Turn 是 daemon 聚合单元。

### AgentEvent
SwiftData 持久化的**单条事件记录**（`@Model AgentEvent`），iOS 本地的事件主存储。
通过 `outboxMessageID` 关联到对应 [OutboxMessage](#outboxmessage)，使 chat bubble 的发送状态指示器始终反映真实状态（含跨重启）。
是 iOS 端本地真相源，daemon/Supabase 是远端复制。

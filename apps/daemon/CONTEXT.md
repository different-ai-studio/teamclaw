# Daemon Context

amuxd 后端守护进程的领域语言。仅术语，不含实现细节。

## Glossary

### Attachment
本 daemon 对某一个 [Session](#session) 的**一次挂载** —— ACP 路由、事件通道、
turn 锁、待注入上下文的持有者。由 `Backend::attach_session` 建立，detach 时销毁。

- 键是 **`session_id`**（稳定），不是每次启动新生成的 id
- 一个 (actor, Session) **恰好 0 或 1 个** Attachment
- **纯内存态**。没有对应的 DB 行，也没有对应的 retain topic

Attached 即 live。Session 的三档可见状态由此派生：
attached 且有未完成 turn = 正在回复；attached 且空闲 = 待命；未 attached = 冷。

**detach 条件**（两者先到先触发，见 ADR-0004）：空闲 **30 分钟**，或挂载数达
**上限 16** 时按 LRU 挤出。这两个数不是调优参数 —— 它们定义了"待命"这个状态的
保质期与容量，是领域参数。

_Avoid_: Runtime、RuntimeHandle、runtime_id（见下）

### Runtime（已废弃）
不再使用。该词历史上同时指两个层级，是 stale-id 类缺陷的来源：

| 曾经指 | 现在叫 |
|---|---|
| opencode 后端进程 | [AgentHostGeneration](#agenthostgeneration) |
| 每 session 一次挂载（`runtime_id` 键控） | [Attachment](#attachment) |

`runtime_id` 一并废除 —— 它是每次启动新生成的一次性 id，结构上无法保持正确。
见 ADR-0004。

### IsolationDomain
OpenCode host 的 workspace 级隔离边界。注册 workspace 以稳定 workspace id
键控；其 root 与 worktree 共用 domain，再由 OpenCode `directory` query 区分 cwd。
无法解析 workspace 的 gateway session 才使用 team + actor 键控的 unscoped domain。

### AgentHostGeneration
一个 isolation domain 某一份 immutable process environment 对应的
`opencode serve` HTTP 进程。每个 domain 恰有 0 或 1 个 current generation，也可
暂时有仍承载旧 [Attachment](#attachment) 的 draining generations。环境修订只会
rolling 新 generation，不会修改 live session 的环境；Attachment 始终绑定创建它的
generation，SSE、permission、question 与 command route 也在该 generation 内。

amuxd 的 host pool 全局上限是 idle TTL 300 秒、soft limit 2、hard limit 3；
容量不足时 FIFO 等待，active/draining generation 不被驱逐。每个 generation 的
PGID 单独登记，daemon 可同时清理多个 process group。后端可用性仍通过
`ActorPresence` 报告，让 client 区分「daemon 挂了」与「daemon 在、后端起不来」。
详见 `docs/architecture/single-agent-opencode-http.md`。

### Session
一次**会话**，对应一个 opencode session。承载历史、模型选择、turn 状态。
本 daemon 服务某 Session 时为其持有一个 [Attachment](#attachment)；
Session ↔ Attachment 是 **1:0..1**（每 actor 而言）。

### AgentType
[AgentHostGeneration](#agenthostgeneration) 的**后端实现种类**。即 `amux.AgentType` 枚举，沿用此名（**不重命名**）。
一个 actor 同时**具备**多个（装了哪些二进制），但任一时刻只有一个**活跃** —— 见
[proto.AgentType](../../proto/CONTEXT.md#agenttype) 与 ADR-0002。
区别于 [proto.AgentKind](../../proto/CONTEXT.md#agentkind)（personal vs team，归属类型）。

### Agent（弃用）
不在本 context 使用裸 `Agent` 一词。
- 指本 daemon 对某 session 的挂载时用 [Attachment](#attachment)
- 指后端进程时用 [AgentHostGeneration](#agenthostgeneration)
- 指后端种类时用 [AgentType](#agenttype)
- desktop 端"用户选中的对话对象"语义属于 `desktop` context，不在此定义

### Channel
一个**外部 IM 平台**的接入项（如 wecom、discord、feishu、kook、email、wechat）。
在 `daemon.toml` 中以 `[channels.*]` 配置，由 [Gateway](#gateway) 实例化运行。

### Gateway
`teamclu_gateway` crate 提供的运行时组件，把某个 [Channel](#channel) 的协议翻译成对 [Runtime](#runtime) 的调用。
1 Channel ↔ 1 Gateway 实例。

### Bus
client ↔ daemon 的**双向消息总线**。
有两种实现：MQTT、NATS。上层不感知具体后端。
区别于：
- [Gateway](#gateway)（对外部 IM 平台）
- opencode HTTP transport（daemon ↔ [Runtime](#runtime) 的 `opencode serve` HTTP/SSE）

### Turn
[Session](#session) 内一次完整的**用户消息 → agent 响应**往返。
包含该轮的所有 parts（文本、思考、工具调用、工具结果等）。
`turn_aggregator` 把流式 opencode event 聚合为单个 Turn 用于落库与广播。

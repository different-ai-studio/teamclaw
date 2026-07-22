# Daemon Context

amuxd 后端守护进程的领域语言。仅术语，不含实现细节。

## Glossary

### Runtime
面向 client 的**运行时句柄**。底层由单个全局 opencode 进程
（官方 sst/opencode，`opencode serve` HTTP）承载；`RuntimeManager`
负责 supervisor 生命周期与状态。一个 Runtime 可承载多个 [Session](#session)。
详见 `docs/architecture/single-agent-opencode-http.md`。

### Session
Runtime 之上的一次**会话**，对应一个 opencode session。
承载历史、模型选择、turn 状态。
Session ↔ Runtime 为多对一。

### AgentType
Runtime 的**后端实现种类**。历史上有 `ClaudeCode` / `Opencode` / `Codex`；
现役后端仅 `Opencode`，其余枚举值保留在 wire 类型中用于渲染历史数据。
即 `amux.AgentType` 枚举，沿用此名（**不重命名**）。
区别于 [proto.AgentKind](../../proto/CONTEXT.md#agentkind)（personal vs team，归属类型）。

### Agent（弃用）
不在本 context 使用裸 `Agent` 一词。
- 指进程对端时用 [Runtime](#runtime)
- 指后端种类时用 [AgentType](#agenttype)
- desktop 端"用户选中的对话对象"语义属于 `desktop` context，不在此定义

### Channel
一个**外部 IM 平台**的接入项（如 wecom、discord、feishu、kook、email、wechat）。
在 `daemon.toml` 中以 `[channels.*]` 配置，由 [Gateway](#gateway) 实例化运行。

### Gateway
`teamclaw_gateway` crate 提供的运行时组件，把某个 [Channel](#channel) 的协议翻译成对 [Runtime](#runtime) 的调用。
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

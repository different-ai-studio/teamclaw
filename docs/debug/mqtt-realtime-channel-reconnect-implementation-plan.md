# MQTT 实时通道重连架构改造计划

> 状态：代码实现已完成于 `fix/p2-daemon-status-probe`，MQTT 改动尚未提交；真实 broker 故障注入仍需在可控环境验收
>
> 目标：一次性完成 MQTT worker、连接 supervisor、业务 command executor 和独立 watchdog 的拆分，消除当前 90 秒固定等待以及主事件循环被业务 handler 卡死后无法自愈的问题。
>
> 适用分支：`fix/p2-daemon-status-probe`

## 1. 目标与非目标

### 1.1 目标

1. MQTT 网络事件循环与 socket/HTTP/cron/渠道业务处理彻底解耦。
2. 普通网络/TLS 抖动时由 rumqttc 自动重连；在合理窗口内没有恢复时，由 supervisor 重建 MQTT client。
3. 重建超时、重连退避和 watchdog 不依赖被监控的 MQTT/业务主循环。
4. MQTT reconnect、订阅恢复、presence/state 重发、发送队列和连接代次具备清晰的生命周期边界。
5. 任意一个业务 handler 的慢 HTTP、RPC、ACP、QR 或文件操作不会阻塞 MQTT `poll()`。
6. 能从日志判断：断开原因、连接尝试次数、连接代次、当前 handler、最后一次 event-loop heartbeat，以及最终是自动恢复还是 full rebuild。
7. daemon 在不重启进程的情况下恢复常见的 DNS、TCP、TLS、broker 重启和睡眠唤醒场景。

### 1.2 非目标

- 本次不修改 MQTT broker、Caddy、NanoMQ 或 mqtt-auth 的协议和部署配置。
- 不把 JWT 到期重新认定为主要断连根因；只保留认证失败时刷新凭证的路径。
- 不处理 3540 秒连接簇归属不明问题；该问题继续作为独立 P5 观察项。
- 不把 P3 的 NanoMQ 探针 `Object closed` 日志治理混入核心重连改造。
- 不通过扩大进程级重启范围解决问题；目标是只重建 MQTT worker/client。
- 不用一个全局 `tokio::timeout` 粗暴包住所有业务 handler。

## 2. 当前实现与确定的问题

### 2.1 当前关键代码

- MQTT 入口和 reconnect loop：`apps/daemon/src/daemon/server.rs:945`。
- `MQTT_DISCONNECT_REBUILD = 90s`：`apps/daemon/src/daemon/server.rs:83-95`。
- MQTT 主 `tokio::select!`：`apps/daemon/src/daemon/server.rs:1828-2110`。
- `SockCommand` 定义：`apps/daemon/src/daemon/server.rs:221-390`。
- socket/HTTP command bridge：`apps/daemon/src/daemon/server.rs:1207-1304`。
- socket command listener：`apps/daemon/src/daemon/server.rs:2733-3226`。
- MQTT client/keepalive：`apps/daemon/src/mqtt/client.rs:77-115`。
- 重连后订阅和 presence/state 恢复：`apps/daemon/src/daemon/server.rs:878-938`。

### 2.2 当前恢复流程

```text
rumqttc::EventLoop::poll()
  -> transient error
  -> mqtt_connected = false
  -> 当前 select 分支同步 sleep 5s
  -> 50ms 分支开始 disconnected_since
  -> 继续依赖 rumqttc 自动重连
  -> ConnAck：清零断开计时并重新订阅
  -> ConnectionRefused：立即刷新凭证并跳出外层 loop
  -> 断开计时满 90s：销毁 client，刷新凭证，外层重新建连
```

### 2.3 已确认的结构性问题

1. `90s` 是硬编码的 wall-clock fallback，不是基于明确连接尝试次数的策略。
2. transient error 分支的 `sleep(5s).await` 位于 `select!` 分支内部，会暂停该轮 event loop 的其它分支。
3. 50ms 检查、proactive reconnect、MQTT poll 和大量 `SockCommand` handler 共用一个 event loop。
4. 任一未拆出的裸 `.await` 都可能阻塞 `poll()`、90 秒计时器和 proactive timer。
5. 当前 90 秒计时器依赖被监控的 event loop，本身不能作为独立 watchdog。
6. 只有少数 handler 已经后台化；其余包括 channel、QR、local RPC、live ingest、workspace、prewarm 等仍有 inline await。
7. full rebuild 会丢弃旧 `AsyncClient` 的内存队列；当前 RuntimeManager 的暂停取事件策略不能覆盖所有已经进入 MQTT client 队列的数据。
8. 当前日志没有统一的连接代次、重连尝试、状态迁移、active handler 和 event-loop heartbeat。

## 3. 目标架构

```text
                         +-----------------------------+
                         | MQTT Connection Supervisor  |
                         | - generation                |
                         | - recovery deadline         |
                         | - backoff                   |
                         | - credential policy         |
                         | - independent watchdog     |
                         +-------------+---------------+
                                       |
                             owns JoinHandle / restart
                                       |
                         +-------------v---------------+
                         | MQTT Worker                 |
                         | - owns MqttClient           |
                         | - owns EventLoop::poll()    |
                         | - no business handler await |
                         | - heartbeat                 |
                         | - subscriptions             |
                         +------+-----------------------+
                                |
              bounded events/commands, generation-tagged
                                |
                 +--------------v----------------+
                 | Daemon Command Executor       |
                 | - owns business DaemonServer  |
                 | - serializes &mut self work   |
                 | - runs safe slow work detached|
                 | - handles SockCommand         |
                 +--------------+-----------------+
                                |
             +------------------+------------------+
             |                                     |
       Unix socket / HTTP                  RuntimeManager / ACP
       parser + reply                    cloud / channel handlers
```

### 3.1 所有权边界

#### `MqttSupervisor`

新增 `apps/daemon/src/daemon/mqtt_supervisor.rs`，负责：

- 建立和销毁 MQTT worker generation；
- 保存当前 generation、连接状态、断开原因和恢复 deadline；
- 管理 transport recovery window、full rebuild 和指数退避；
- 管理 credential refresh policy；
- 监控 worker heartbeat；
- 在 worker 不响应时按“fence publisher → 停止接收新请求 → 等待/终止旧 worker → 确认旧引用释放 → 创建下一代”的顺序切换；
- 对旧 generation 的迟到事件做丢弃，不能让旧 worker 修改新连接状态。

Supervisor 不直接处理 MQTT payload，也不持有 `DaemonServer` 的 `&mut self`。

#### `MqttWorker`

可以作为 `mqtt_supervisor.rs` 内部的 worker，负责：

- 独占一个 `MqttClient` 和 `EventLoop`；
- 唯一位置调用 `eventloop.poll()`；
- 处理 `ConnAck`、Publish、PingResp、transport error 和 ConnectionRefused；
- 处理 subscribe/resubscribe；
- 将 inbound MQTT message 通过 bounded event channel 发送给 command executor；
- 从 bounded publish queue 读取 outbound message；
- 更新 task liveness、poll phase、poll start/return 和连接状态；
- 不调用 `handle_incoming`、`dispatch_local_rpc`、cron、channel、ACP 等业务 handler。

`eventloop.poll()` 不加可取消的普通 timeout。`MqttOptions`/`EventLoop` 使用显式 network connection timeout；只有在 poll pending 超过 keepalive 与 network timeout 的组合上限、并完成 generation fence 后，才走受控的 `EventLoop::clean()`/worker termination recovery。不能用 5～10 秒无事件直接判定 poll 卡死。

#### `DaemonCommandExecutor`

可以放在 `apps/daemon/src/daemon/server/command_executor.rs`，或在现有 `server.rs` 中先抽出独立 child module，负责：

- 独占需要 `&mut DaemonServer` 的业务状态；
- 消费 `SockCommand`、HTTP bridge command 和 MQTT inbound event；
- 保持有副作用命令的串行语义；
- 对已经确认 cancellation-safe 的慢操作后台化；
- 通过 `MqttPublisherHandle` 向 worker 发送 outbound publish；
- 通过原有 oneshot reply channel 给 socket 调用方返回结果；
- 记录每个 command 的开始、结束、耗时和失败原因。

不能简单把整个 `DaemonServer` 包进 `Arc<Mutex<_>>` 后对每个 command `tokio::spawn`：当前 `teamclu` 等状态有非 `Send`/顺序约束，且会把大锁持有时间隐藏起来。应保留一个业务 owner，通过消息驱动拆分网络 worker。

#### 稳定 publisher 与 worker 接口

业务层必须只持有一个跨 generation 稳定的 `GenerationPublisher`，不能继续持有某代 `rumqttc::AsyncClient`。建议接口明确为：

```rust
struct GenerationPublisher {
    ingress_tx: mpsc::Sender<PublishRequest>,
    // 只读状态：当前 generation、phase、是否允许新消息进入 outbox
    state: Arc<PublisherRouteState>,
}

enum MqttWorkerCommand {
    Publish(PublishRequest),
    ApplySubscriptionPlan {
        generation: u64,
        plan: SubscriptionPlan,
        reply_tx: oneshot::Sender<Result<(), MqttWorkerError>>,
    },
    Stop {
        generation: u64,
        reply_tx: oneshot::Sender<()>,
    },
}

enum MqttWorkerEvent {
    TransportConnected { generation: u64 },
    SubscriptionsReady { generation: u64 },
    Inbound(InboundEnvelope),
    TransportError { generation: u64, kind: String },
    WorkerExited { generation: u64, reason: WorkerExitReason },
}
```

`GenerationPublisher` 实现现有 `MessagePublisher` trait，内部只向 supervisor 的稳定 ingress channel 投递；`SessionManager`、`LivePublisher`、`NotifyPublisher`、`RpcServer` 和后台任务均保存这个 proxy 的 `Arc`。supervisor 重建 worker 时只替换内部 route，不替换业务对象中的 `Arc`。`publish/subscribe/unsubscribe` 的 channel 容量、reply、generation 校验和 queue full 行为必须在实现前固定下来。

## 4. 连接状态机与时序

### 4.1 状态

```text
Starting
  -> Connected
  -> Recovering
  -> Rebuilding
  -> Backoff
  -> Starting
```

每个 generation 维护：

```rust
struct MqttConnectionSnapshot {
    generation: u64,
    phase: MqttPhase,
    connected_since: Option<Instant>,
    disconnected_since: Option<Instant>,
    attempts: u32,
    last_error_kind: Option<String>,
    last_error_at: Option<Instant>,
    last_connack_at: Option<Instant>,
    last_poll_progress_at: Instant,
    credential_expiry_epoch: Option<i64>,
}
```

状态必须至少区分：

```text
TransportConnected
  -> SubscriptionsPending
  -> SubscriptionsReady
  -> GenerationReady
```

只有 `GenerationReady` 才把 `/v1/info.mqtt_connected` 的 active flag 设为 `true`。这样 UI 不会在 ConnAck 之后、SUBACK/状态恢复之前过早显示在线；日志仍单独记录 transport connected。

动态订阅不能由只拥有 `MqttClient` 的 worker 自己推导。executor 根据当前 `MqttClient::Topics`、`SessionManager` 的 membership/live session 集合生成不可变的：

```rust
struct SubscriptionPlan {
    topics: Vec<(String, DeliveryGuarantee)>,
    generation: u64,
}
```

worker 执行 plan，并跟踪每个 subscribe packet 的 SUBACK；`AsyncClient::subscribe()` 返回“请求已进入 client queue”不等于 broker 已确认。全部必要 SUBACK 到达后才发送 `SubscriptionsReady`，再由 executor 完成 presence/state publish，最后发送 `GenerationReady`。

### 4.2 推荐时序参数

首版采用明确的可配置常量，默认值如下：

| 参数 | 默认值 | 作用 |
|---|---:|---|
| `MQTT_RECOVERY_WINDOW` | 30s | transport 断开后，允许当前 worker/rumqttc 自动恢复的最长窗口 |
| `MQTT_RECONNECT_BACKOFF_INITIAL` | 500ms | 新一轮连接尝试的初始退避 |
| `MQTT_RECONNECT_BACKOFF_MAX` | 10s | 单次退避上限 |
| `MQTT_WORKER_STALL_WARN` | 5s | worker task liveness 停滞告警；不是 poll 无 MQTT event 的阈值 |
| `MQTT_POLL_PENDING_WARN` | 45s | poll 持续 pending 的诊断阈值，结合 30s keepalive，不直接重建 |
| `MQTT_POLL_PENDING_REBUILD` | 75s | poll pending 超过 keepalive/network timeout 组合上限后的受控恢复阈值 |
| `MQTT_STARTUP_GRACE` | 15s | 已由前端状态层处理的启动 MQTT 探测宽限 |
| `MQTT_OUTBOX_MAX` | 配置项 | outbound 内存队列上限，禁止无限增长 |

`30s` 是 transport recovery 策略，不是 poll-stall watchdog 的阈值。watchdog 必须区分“worker task 仍活着但 poll 正常等待网络”和“task 真正不再推进”。必须在 30s keepalive、5s network timeout 的实际参数下校准 45s/75s，不能用 5～10s 无事件误杀空闲连接。

### 4.3 错误分类

| 错误类型 | 处理方式 |
|---|---|
| `ConnAck` 成功 | phase=`TransportConnected`，不立即对外宣称 generation ready |
| DNS/TCP/TLS/EOF/未连接 | phase=`Recovering`，允许 worker 自动重试；超过 30s 后重建 generation |
| 明确认证拒绝 | 按 reason code 分类；只有 auth/ACL/token 类拒绝才作废 cached credential，获取新 token 后重建 |
| subscribe/resubscribe 失败 | 标记当前 generation 不健康，进入 rebuild；保留失败上下文 |
| publish queue 满 | 明确返回 backpressure/drop 结果并记日志，不静默丢弃 |
| worker heartbeat 超时 | supervisor 终止当前 worker generation，独立创建下一代 |

不能把每一次 `poll()` 返回的 error 都当成一次真实连接尝试。attempt 只在 worker 实际开始新 socket/connect generation 时递增；日志同时保留 poll error 次数，避免两者混淆。`ConnectionRefused` 必须按 rumqttc reason code 分成认证、ACL、协议和服务端暂不可用，不能统一刷新 token。

## 5. 连接重建流程

### 5.1 建立新 generation

1. Supervisor 分配递增的 `generation`。
2. 根据 credential policy 获取 token：
   - 认证拒绝或 token 即将过期：强制作废缓存并刷新；
   - 单纯 transport failure 且 token 仍有效：优先复用有效 credential，避免无意义地频繁刷新；
   - 如新 generation 仍收到认证拒绝，再进入一次强制 refresh。
3. 创建 `MqttClient`、`AsyncClient` 和 `EventLoop`。
4. 将当前 generation 的 `AsyncClient` 只交给 worker；业务层继续使用同一个 `GenerationPublisher` proxy。
5. worker 等待 `ConnAck`，成功后发送 `TransportConnected { generation }`，但不更新对外 `mqtt_connected`。
6. executor 生成 `SubscriptionPlan`，worker 执行所有 base/team/live subscribe 并等待 SUBACK。
7. 收到 `SubscriptionsReady` 后，executor 按固定顺序发布 presence、actor snapshot、agent state 和必要的 pending outbox。
8. 全部恢复动作成功后发送 `GenerationReady`，再更新 `/v1/info.mqtt_connected`。

### 5.2 旧 generation 隔离

- 每条 worker event、publish completion、rebuild request 都带 `generation`。
- command executor 只接受当前 generation 的 Connected/Disconnected event。
- 旧 worker 在 abort 后产生的迟到 event 必须被丢弃。
- `mqtt_connected_flag` 只能由当前 generation 更新。
- full rebuild 时先将旧 `GenerationPublisher` route 标记为 fenced，阻止新消息进入旧代；
- 将旧代尚未发送的 publish request 转移到 supervisor outbox 或明确返回失败；
- 发送 `Stop`，等待旧 worker `JoinHandle` 完成；只有确认旧 `AsyncClient`、worker command receiver 和 publish future 引用释放后才创建新 client；
- 新 worker 启动后再切换 proxy route，旧 generation 的 completion 一律返回 `StaleGeneration`。

## 6. Publish queue 与消息一致性

### 6.1 发送路径

将当前直接克隆 `AsyncClient` 的发布路径改成：

```text
business handler
  -> MqttPublisherHandle
  -> bounded MqttWorkerCommand queue
  -> current MqttWorker AsyncClient
```

业务代码不再持有某一代 `AsyncClient` 的裸 clone，否则 rebuild 后会继续向旧 client 投递。

`GenerationPublisher` 的 ingress channel 由 supervisor 持有，容量按消息数和 payload bytes 双限流；outbox 由 supervisor 持有，不放在 worker 内，避免 worker abort 时一起丢失。`PublishRequest` 必须带 `message_class`、`event_id/dedup_key`、QoS、retain、入队时间和 completion oneshot。

`publish()` 的成功语义固定为“已进入 supervisor outbox/worker ingress”，不伪装成 broker ACK；需要 broker ACK 的 control/state 消息由 worker 跟踪 packet id 并完成对应 oneshot。state 消息按 `(topic, state_key)` coalesce，RPC response 按 request id 保留 deadline，过期请求返回明确错误；live chunk 只能按 event id/序列策略合并或丢弃。

### 6.2 Inbound backpressure 策略

Inbound 不能简单使用 `send().await` 或 `try_send()`：前者会因为 executor 慢而停止 `poll()`，后者可能在 QoS1 已被 client 接收后静默丢消息。

本次采用两级队列：

1. worker 到 inbound dispatcher 使用按**字节数和消息数双上限**的 bounded staging queue；worker 只能把 MQTT envelope 转移到该队列，不直接调用业务 handler。
2. dispatcher 将需要可靠处理的 control/RPC envelope 写入本地 durable inbox，再交给单一 command executor；写入完成前不能报告 accepted。
3. QoS0 live chunk 不进入 durable inbox，使用合并/丢弃策略并记录 dropped bytes/events；QoS1/control 不得静默丢弃。
4. staging queue 和 durable inbox 都满时，进入明确的 `InboundBackpressure` 状态：暂停向业务派发、记录指标，并验证 rumqttc 对当前 packet 的 ACK/redelivery 行为；不能靠无限内存掩盖问题。
5. integration test 必须验证 broker 重连、进程中止和 inbox replay，确认可靠消息不会因 executor 慢而丢失；如果 rumqttc 自动 ACK 时机无法满足 durable 语义，则必须调整协议/客户端 ACK 配置，而不是假设 QoS1 自动可靠。

Inbound queue 的容量、持久化位置、清理策略、重复 message id 去重和恢复顺序必须在代码中显式定义。

### 6.3 断开期间策略

- RuntimeManager 继续暂停取出新的 live event；
- 已生成且需要保证的消息进入 bounded outbox；
- outbox item 带 topic、payload、QoS、event id、generation-independent dedup key；
- 重连成功并完成订阅后按顺序 flush；
- 超过上限时采用明确策略：优先保留 control/state，live chunk 按 event id 合并或丢弃，并输出统计；
- 不承诺对所有大块 live chunk 做无限可靠缓存。

### 6.4 重连后的恢复顺序

```text
ConnAck
  -> MQTT team subscriptions
  -> teamclu subscriptions
  -> actor presence
  -> full actor state
  -> all agent states
  -> bounded outbox
  -> resume RuntimeManager event drain
```

恢复顺序要有单测，避免出现“显示在线但尚未订阅”或“重连后只发布空 presence、覆盖真实 state”的回归。

## 7. Command executor 拆分策略

### 7.1 主循环禁止执行的工作

以下工作不能继续放在 MQTT worker 的 `select!` 分支：

- `reload_channels`、channel status/chat list、channel save；
- `handle_mcp_send`、`handle_channel_send`；
- `dispatch_local_rpc`、`ingest_session_live`；
- `handle_cron_prepare_session`；
- WeChat/WeCom QR start/poll；
- `handle_add_workspace_sock`；
- `kick_prewarm_for_workspace`；
- 任意 cloud API、gateway HTTP、文件扫描、ACP turn 等不可控耗时操作。

### 7.2 执行模型

- Socket listener 只负责解析 JSON、校验最小字段、发送 `SockCommand` 和写 reply。
- `DaemonCommandExecutor` 对需要 `&mut self` 的操作串行执行，避免数据竞争。
- 已经具备安全边界的长任务（例如 cron turn、remote tool、permission wait）继续采用后台 task + completion event；completion event 不得要求 MQTT worker 等待。
- 对有副作用的操作不直接套取消型 timeout；在具体 HTTP/RPC client 内设置超时，并让操作具备幂等 key 或明确的失败状态。
- 每个 command 必须保证 reply：成功、业务错误、取消、executor shutdown 都要完成 oneshot，不能让客户端无限等待。
- command channel 需要有明确容量和满载行为；不能因为 MQTT 暂停导致 HTTP/socket listener 无限阻塞。

### 7.3 生命周期与 shutdown

- `DaemonServer` 仍是业务 owner；`MqttSupervisor`、`DaemonCommandExecutor` 和 socket listener 的 JoinHandle 由 `run()` 统一保存和等待。
- supervisor 每次新建 generation 都从当前可变配置读取 team/broker/actor identity；不能只复制启动时的 `DaemonConfig`。现有 `run()` 对 onboarding 后 team_id 自愈的逻辑必须通过 `ConfigSnapshot`/rebuild request 传递给 supervisor。
- MQTT 与 NATS 的 transport worker 可以共享 command executor 协议，但 NATS 的连接生命周期和旧 run loop 继续独立；不能让 MQTT supervisor 误接管 NATS。
- shutdown 顺序固定为：停止接受新 socket/HTTP command → 向 executor 发送 shutdown → fence publisher → 请求 worker stop → 等待 worker JoinHandle → flush/失败 queued replies → 删除 socket path。
- executor shutdown 时为所有 queued/in-flight oneshot 回复 `daemon_shutting_down`；socket listener 收到该结果后关闭连接。进行中的外部任务要有取消 token，不能留下永不完成的 reply。
- worker rebuild 与 daemon shutdown 使用不同的 reason，shutdown 不触发 backoff/reconnect；旧 generation 的 delayed completion 必须在 shutdown 后被丢弃。

### 7.4 诊断信息

每个 command 记录结构化字段：

```text
command_id
command_name
source: sock | http | mqtt
started_at
finished_at
duration_ms
outcome
active_generation
```

超过 `5s` 输出 warning，超过 `10s` 输出 error，并包含当前 command 名称。日志不能包含 token、完整 payload 或用户敏感内容。

## 8. Watchdog 设计

### 8.1 Heartbeat

MQTT worker 发布两类独立 telemetry，不能只保留一个 `last_poll_progress_at`：

- `task_liveness_at`：由独立 lightweight ticker 更新，证明 Tokio worker task 仍然在运行；
- `poll_phase`：`Idle`、`Connecting`、`WaitingNetwork`、`ProcessingEvent`，并记录 `poll_started_at`、`poll_returned_at`；
- `last_event_at`：最近一次 MQTT Event/Error/PingResp/ConnAck；
- `last_connack_at`、`last_suback_at` 和当前 pending SUBACK 数量；
- 当前 generation、active command、outbox/inbound queue 计数。

`task_liveness_at` 存放在 `Arc<AtomicU64>` 或专用 watch channel，包含 monotonic timestamp 和 generation。`poll()` 正常等待网络时不更新 `last_event_at`，但也不应仅因为它没有更新就被误杀。

### 8.2 Supervisor 处理

- 每 2 秒检查 task liveness 和 poll phase；
- task liveness 超过 5 秒没有更新：输出 warning，附带 active command、last event 和 error；
- worker task 仍活着且 `poll_phase=WaitingNetwork`：按 `MQTT_POLL_PENDING_WARN/REBUILD` 与 keepalive/network timeout 判断，不能按 5/10 秒判死；
- worker task 无 liveness，或 poll pending 超过组合上限：先 fence publisher、停止新请求、调用受控 `EventLoop::clean()`/结束协议，等待 `JoinHandle`；旧 worker 未退出前不创建新 client；
- 只有确认旧 generation 已停止后，才创建下一代并恢复 route；
- watchdog 自身不能依赖 worker 的 `select!` timer；
- 每次 watchdog rebuild 都要限速，避免异常时形成 abort/restart tight loop。

### 8.3 重要限制

watchdog 只能重建 MQTT worker，不能直接 abort 整个 daemon。若 command executor 也出现长时间停顿，应单独记录，但不能因此让 MQTT 网络层一起停摆。rumqttc 的 `NetworkOptions::connection_timeout` 和 `EventLoop::clean()` 行为必须在集成测试中验证；不能凭“10 秒没有 MQTT event”判断 worker 卡死。

## 9. 代码改造范围

### 9.1 新增

- `apps/daemon/src/mqtt/supervisor.rs`
  - 独立 supervisor task、worker generation、30 秒 recovery deadline、credential refresh、heartbeat watchdog，以及旧 worker 的 graceful-stop/abort 兜底。
- `apps/daemon/src/daemon/server/command_executor.rs`
  - `SockCommand` dispatch、command timing、reply completion、business event fan-in。
- 必要时新增纯数据类型模块，用于 `MqttWorkerEvent`、`MqttWorkerCommand`、`MqttConnectionSnapshot` 和 outbox item。

### 9.2 修改

- `apps/daemon/src/daemon/server.rs`
  - 保留启动、HTTP/NATS 选择和业务状态；
  - 删除 MQTT `select!` 中的业务 handler await；
  - 将 `mqtt_connected_flag`、publisher handle、topics 切换到 supervisor/worker 的 generation-aware handle；
  - 将 `mqtt_resubscribe_after_connack` 拆成 worker subscribe 与 business state republish 两部分；
  - MQTT/NATS 共享的业务 dispatch 不改变协议行为。
- `apps/daemon/src/daemon/mod.rs`
  - 注册新模块。
- `apps/daemon/src/mqtt/client.rs`
  - 保留 client 创建和 transport 配置；
  - 必要时抽出 error classification 和 connection attempt 事件，不在这里放业务重试策略。
- `apps/daemon/src/daemon/server/messaging.rs`
  - 统一使用 generation-independent publisher handle；
  - 保证 reconnect 后 state republish 顺序。
- `apps/daemon/src/daemon/server/rpc.rs`、`channels.rs`、`peers_workspaces.rs`、`cron.rs`、`remote_tools.rs`
  - 改为依赖 command executor 的发布抽象；
  - 保持现有协议、reply shape 和幂等语义。

### 9.3 不应修改的行为

- MQTT topic 命名和 actor identity 不变。
- `/v1/info.mqtt_connected` 仍返回当前 active generation 的真实状态。
- `ConnectionRefused` 不应再被无条件描述为 JWT 过期，日志需要保留 broker reason code。
- NATS 路径继续可用；若共享 executor，必须有 NATS regression tests。

## 10. 测试计划

### 10.1 纯单元测试

- state transition：Connected/Recovering/Rebuilding/Backoff；
- 30 秒 recovery deadline；
- 认证拒绝立即 refresh；
- transport failure 不立即刷新 token；
- exponential backoff + jitter 上限；
- generation 隔离和迟到 event 丢弃；
- task liveness、WaitingNetwork poll pending、keepalive/network timeout 三类 watchdog 判定；
- outbox 上限、合并、flush 顺序和 overflow policy；
- command reply 在成功、错误、取消、executor shutdown 时都只发送一次。

### 10.2 daemon 集成测试

- broker 正常启动后完成 ConnAck、subscribe 和 state publish；
- broker 重启后 30 秒内完成 worker rebuild 并恢复订阅；
- DNS 失败、TCP reset、TLS EOF、peer close；
- ConnectionRefused 后刷新 credential；
- 业务 command 阻塞 30 秒时 MQTT worker 仍能 heartbeat/重连；
- MQTT worker task liveness 停止或 poll pending 超过组合阈值时 supervisor 能只重建 MQTT worker；
- rebuild 时旧 generation 的事件不会污染新状态；
- NATS transport 不受影响。

### 10.3 手工/故障注入场景

1. 启动 daemon 后立刻阻断 broker，确认 UI 不会永久显示旧状态。
2. 运行中断 DNS/TCP/TLS，记录首次错误到 ConnAck/full rebuild 的时延。
3. 重启 NanoMQ，确认不需要重启 daemon。
4. macOS 睡眠 1～5 分钟后唤醒，确认 heartbeat、PingResp、重连和 state 恢复。
5. 触发慢 QR/cloud/RPC/cron handler，同时观察 MQTT event log 是否继续推进。
6. 连续制造失败，确认退避不会形成连接风暴。

### 10.4 验收指标

- 普通网络抖动恢复 P95 小于 5 秒。
- broker/DNS/TLS 故障在 worker 可运行时不超过 30 秒进入 full rebuild。
- worker task liveness 停止时能及时触发 MQTT worker rebuild；正常空闲连接在 30s keepalive 下不会被误杀。
- 任意单个业务 handler 持续 30 秒时，MQTT heartbeat 不停止。
- rebuild 后订阅、presence、actor state、agent state 均恢复。
- 没有旧 generation 对新 generation 的状态污染。
- 日志可以完整回答“什么时候断、为什么断、重试了几次、谁触发了重建、何时恢复”。

## 11. 实施约束与风险控制

### 11.1 不采用的做法

- 不把 `MQTT_DISCONNECT_REBUILD` 单独改成 `15s` 就结束。
- 不把所有 `.await` 简单包一层 `tokio::timeout`。
- 不在 worker 内取消正在进行的 `eventloop.poll()` 作为正常重试手段。
- 不把所有 handler 并行 `spawn`，避免 `DaemonServer` 状态竞争、回复乱序和重复副作用。
- 不用无界 channel 或无界 outbox 掩盖 backpressure。

### 11.2 主要风险与对策

| 风险 | 对策 |
|---|---|
| worker 与业务拆分后 publisher 句柄失效 | 所有发布都经过 generation-independent handle；旧 generation sender 自动失败 |
| 重建后订阅/retain/state 顺序错误 | 将 ConnAck 恢复流程拆成固定步骤并增加集成测试 |
| 业务 command 并发导致重复副作用 | 保留单一 command owner；仅后台化已分类的慢操作 |
| watchdog 误判导致频繁重建 | heartbeat 事件定义清晰；连续超时确认；重建全局限速 |
| outbox 内存增长 | 有界队列、分类优先级、overflow 日志和指标 |
| 凭证被无意义刷新 | 仅认证失败或过期窗口强刷；transport rebuild 优先复用有效 credential |
| NATS 回归 | 保持 NATS 独立 run loop，增加 NATS 测试和编译验证 |

## 12. 一次性实施顺序

这里的“分步骤”只是代码落地顺序，不是先上线半成品再观察的分阶段方案；本次 PR 必须在所有边界、watchdog、重连、队列和测试完成后才算可用。

1. 抽取并冻结 MQTT/worker 的事件与命令类型、连接状态快照、generation 规则和错误分类。
2. 实现 `MqttPublisherHandle`、bounded publish queue 和 generation-aware completion；先让所有 publisher 不再直接依赖旧 `AsyncClient`。
3. 实现 `MqttWorker`：只拥有 `MqttClient/EventLoop`，处理 poll、ConnAck、subscribe、publish queue 和 heartbeat。
4. 实现 `MqttSupervisor`：负责 token policy、30 秒 recovery deadline、backoff、worker generation 和独立 watchdog。
5. 把当前 `mqtt_resubscribe_after_connack` 拆成 worker 订阅动作与 command executor 的 state/presence 重发动作。
6. 实现 `DaemonCommandExecutor`，把 SockCommand、HTTP bridge 和 MQTT inbound event 从 MQTT worker 移出；保留必须的业务串行语义。
7. 将 cron、remote tool、permission 等已经具备后台执行模式的路径接入新的 completion channel；为其余慢 handler 加内部超时、幂等或取消边界。
8. 从 `DaemonServer::run` 删除旧的 5 秒 inline sleep、90 秒 event-loop timer 和 MQTT 内联业务 handler；接入 supervisor/executor 生命周期和 shutdown 顺序。
9. 加入 outbox flush、重连恢复顺序、旧 generation 隔离、shutdown/rebuild race 的测试。
10. 运行 format、daemon tests、相关 app tests 和故障注入；修复所有阻断性 review 意见后再提交代码评审。

## 13. 实施完成定义

只有以下条件全部满足，才算本次架构改造完成：

- MQTT `poll()` 不再和业务 handler 共用同一个可被业务 await 卡住的 loop。
- 90 秒硬编码 fallback 被 supervisor 的独立 recovery deadline 替代。
- 独立 watchdog 可以在 event loop 停滞时重建 MQTT worker。
- 连接、订阅、presence、state、outbox 的重建顺序经过测试。
- 现有 socket/HTTP/MQTT/NATS 协议行为和 reply shape 没有回归。
- 故障注入场景不需要重启 daemon 进程即可恢复。
- 相关 Rust 单测和编译检查通过；全仓 `cargo fmt --check` 仍受 main 分支既有无关格式问题影响，真实 broker 故障注入未在本地执行。
- Subagent review 的阻断性意见已处理，并在本文件末尾记录 review 结果。

## 14. Subagent Review 记录

### Review agent

`multi_agent_v1` agent `Mencius`，review 日期：2026-08-21。

### Review 结论

初版计划方向正确，但不能直接进入实现。review 指出的阻断点已在本版本补充：

1. **Publisher 生命周期**：新增 `GenerationPublisher` 稳定 proxy、稳定 ingress、旧 generation fencing 和 publish completion 规则；明确现有 `SessionManager`、`LivePublisher`、`NotifyPublisher`、`RpcServer` 不能继续保存裸 `AsyncClient`。
2. **动态订阅**：新增 `SubscriptionPlan`，由 executor 生成、worker 执行；恢复必须等待 SUBACK，分离 `TransportConnected`、`SubscriptionsReady`、`GenerationReady`。
3. **Watchdog 误判**：移除“10 秒无 event 就重建”的规则，改为 task liveness、poll phase、keepalive/network timeout 三类信号；正常 30 秒 keepalive 空闲不能被误杀。
4. **Inbound backpressure**：明确 bounded staging queue + durable inbox 的责任边界、QoS0/QoS1 策略、字节/消息双上限和满载行为；禁止 `send().await` 阻塞 worker，也禁止静默 `try_send()` 丢可靠消息。
5. **旧 worker 终止协议**：补充 fence → 停止接收 → 转移/失败 pending publish → 等待 JoinHandle → 确认引用释放 → 创建新 generation 的顺序。
6. **Outbox 语义**：明确 outbox owner、双上限、publish 成功语义、broker ACK 跟踪、state coalesce、RPC deadline 和 live chunk 策略。
7. **运行时配置和 shutdown**：补充 onboarding/config 自愈、NATS 分支边界、executor/worker/listener JoinHandle 和 shutdown reply 行为。
8. **错误分类和测试**：要求按 reason code 区分认证/ACL/协议/服务端错误，并补充 SUBACK、空闲 watchdog、旧 generation、inbound 满载、shutdown 和 NATS 回归测试。

### Review 后的实现门槛

在上述接口和生命周期规则没有落成具体 Rust 类型、channel 容量、queue overflow 行为及测试之前，不进入 `server.rs` 大规模迁移。尤其不能先写一个“能重连”的 demo，再补 publisher/outbox/旧 worker 释放；那会把最难验证的数据一致性问题留到线上。

## 15. 本次实施核对

本轮代码已落地以下边界：

1. `AsyncClient`/`EventLoop` 只由 MQTT worker 持有，业务模块只持有稳定的 `MqttPublisher` proxy。
2. 原 90 秒主循环兜底已移入 supervisor，默认恢复窗口为 30 秒；重建过程不再在 `poll()` 分支内固定 sleep 5 秒。
3. 连接阶段拆为 `TransportConnected`、`SubscriptionsReady`、`GenerationReady`；worker 等待 SUBACK，只有完整恢复后才更新 `mqtt_connected`。
4. 连接代次、readiness fence、durable inbox/outbox 和 QoS ACK 跟踪已实现；业务 executor 只记录慢命令，不在副作用操作外层强行取消 future。
5. watchdog 独立于 worker 的 MQTT select，分别观察 task liveness 与 poll pending；45 秒只诊断，75 秒才请求受控重建，避免把 30 秒 keepalive 的空闲连接误判为断连。
6. MQTT inbound 已通过 `DaemonCommandExecutor` 进入业务 owner，worker 不再调用业务 handler。
7. supervisor 与 worker 已拆成不同 Tokio task；watchdog 请求由 supervisor 接收，先停止并等待旧 worker，超时才 abort，再创建下一代，避免 watchdog 被卡住的 `poll()` 反向阻塞。
8. `DaemonServer` 不再持有 `MqttClient`/`AsyncClient`，RPC response 也统一经过稳定 publisher proxy；订阅计划由 supervisor 保留并传给下一代 worker。

已验证：

- `cargo check -p amuxd --locked`
- `cargo test -p amuxd mqtt::supervisor --locked`
- `cargo test -p amuxd mqtt::durable_queue --locked`
- `git diff --check`
- 全量 `cargo test -p amuxd --locked`：1197 passed、88 failed；失败均集中在当前沙箱禁止绑定本地端口的 HTTP/wiremock/runtime 测试，未见 MQTT 相关编译或定向单测失败。

`cargo fmt --check` 仍会报告仓库中既有的非本次改动格式问题；本轮未用全仓格式化覆盖这些无关改动。真实 broker 重启、TCP reset、TLS EOF 和睡眠唤醒场景需要在可控测试 broker 环境中做集成故障注入，不能由本地编译单测替代。

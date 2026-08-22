# MQTT 实时通道睡眠唤醒与断联恢复方案

> 状态：已完成 Subagent review，并按 review 修订；暂不修改实现代码
>
> 适用分支：`fix/p2-daemon-status-probe`
>
> 关联文档：
> - `docs/debug/mqtt-realtime-channel-reconnect-implementation-plan.md`
> - `docs/debug/mqtt-realtime-channel-disconnect-analysis.md`
>
> 本文不是重新设计 MQTT supervisor。此前未提交的 MQTT 架构改造是本方案的
> 基线，本次只补齐“睡眠/唤醒、VPN 恢复后如何主动恢复”和对应的故障注入验收。
> 本文同时明确当前未提交架构改造尚未完成的 durable 语义、代次一致性和安全边界，
> 避免把现有的 at-least-once 实现误写成 exactly-once。

## 0. Review 修订摘要

Subagent review 认为原计划不能直接进入实现，主要缺口已在下文收敛为硬约束和测试：

- durable inbox 缺少跨 MQTT redelivery 的稳定 message id，executor 也没有失败/重试/
  dead-letter 的结果接口；
- `SubscriptionsReady -> GenerationReady` 当前由 `DaemonServer` 完成，必须增加带
  generation/attempt 的取消和 stale completion 防护；
- worker、transport connection、ready 使用了混淆的 generation；需要拆成三个字段；
- outbox 只能保证本地 durable accepted 和 at-least-once replay，不能宣称 Broker delivered
  或 exactly-once；
- 统一 HTTP listener 不能天然保证 loopback，recovery endpoint 必须做 bind/peer 校验、
  coalescing 和限流；
- `/v1/info` 需要单一版本化快照和脱敏错误码；token refresh 的失败共享必须覆盖所有
  Backend 调用方；
- 故障注入必须覆盖 sleep gap 与 UI signal 的触发来源，以及 ACK、compact、restore race
  等崩溃窗口。

## 1. 背景与结论

### 1.1 已经完成、必须保留的改造

当前工作区已经包含以下未提交改动，后续实现必须在此基础上继续：

- `apps/daemon/src/mqtt/supervisor.rs`
  - generation 独立的 MQTT supervisor/worker；
  - worker 独占 `MqttClient` 和 `EventLoop::poll()`；
  - 独立 watchdog；
  - transport recovery deadline 和受控 generation rebuild；
  - stable publisher proxy；
  - 连接代次、订阅恢复、GenerationReady 栅栏；
  - durable inbox/outbox 接入。
- `apps/daemon/src/mqtt/durable_queue.rs`
  - append-only durable inbox/outbox；
  - ACK、恢复、日志压缩和 torn tail 处理。
- `apps/daemon/src/daemon/server.rs`
  - daemon business owner 与 MQTT worker 解耦；
  - MQTT inbound 交给 command executor；
  - `/v1/info.mqtt_connected` 由当前 generation 的 readiness 更新。
- `apps/daemon/src/daemon/server/command_executor.rs`
  - MQTT worker 不再直接执行业务 handler；
  - 业务 ACK 在 handler 完成后发出。
- `apps/daemon/src/mqtt/client.rs`、`apps/daemon/src/mqtt/mod.rs`、
  `crates/teamclu-transport/src/publisher.rs`
  - 传输边界和稳定 publisher 接口调整。
- 已提交的 P2 UI 修复
  - daemon status 统一探测；
  - startup/focus/visibility 时主动刷新 UI 状态；
  - 防止“daemon 已恢复但横幅仍显示断联”。

后续不能退回旧的 `DaemonServer` 内联 MQTT loop，也不能重新让业务对象持有某一代
`AsyncClient`。durable queue 不能因为 recovery 被清空或迁移到 worker 内存中。

### 1.2 日志确认的实际问题

最近一次笔记本睡眠、VPN 断开、重新打开并恢复网络的日志表明：

```text
watchdog 发现 MQTT worker 长时间没有 progress
  -> 请求 controlled generation rebuild
  -> supervisor 停止旧 worker
  -> 获取 cloud access token 失败
  -> worker 一直无法创建
  -> 本地 HTTP/RPC 仍然可用
  -> 最终某次 token refresh 成功后 MQTT generation 才恢复
```

关键点：

1. 90 秒/75 秒 watchdog 只负责发现 worker 失活并请求重建，不保证重建成功。
2. 新 generation 创建前依赖 `backend.auth_token()`，而 token refresh 访问的是
   `copilot.accounting.i.test.shopee.io/v1/auth/refresh`，该路径失败时 MQTT
   worker 会保持 `None`。
3. 笔记本睡眠时 daemon 不能持续执行 5 秒、10 秒、30 秒的定时器；macOS 的
   DarkWake 只能间歇性运行进程。因此代码中的退避间隔不是睡眠状态下的墙上时间。
4. `/v1/healthz`、`/v1/info` 和新建 session 的本地 RPC 走 loopback，不代表 MQTT
   或 cloud API 已恢复。
5. 日志中发送消息发生在 MQTT generation 已经 ready 之后。发送消息不是修复动作，
   只是本地 HTTP/SSE 路径本来就可以独立工作，UI 状态随后才被刷新。

### 1.3 本次要解决的问题

在不重启 daemon、不依赖用户点击“重连”、不依赖发送一条消息的情况下：

- 桌面端从睡眠恢复后，能主动通知 daemon 立即恢复 MQTT；
- VPN/网络恢复后，daemon 能跳过当前 backoff 尽快重新尝试；
- token refresh 失败不会把恢复流程卡在共享 mutex 或重复请求队列中；
- UI 能区分本地 HTTP 可用、MQTT 恢复中、token 恢复中和 MQTT ready；
- MQTT generation 重建期间，durable inbox/outbox、稳定 publisher 和旧 generation
  fence 语义保持不变。

## 2. 目标与非目标

### 2.1 目标

1. 为 daemon 增加一个仅限本机 loopback 使用的幂等 recovery signal。
2. 将桌面端的 wake/visibility/online/focus 事件接入 daemon recovery signal。
3. supervisor 收到 signal 后能够：
   - ready 状态下无动作或只做状态探测；
   - worker 失活时立即停止旧 worker；
   - worker 正在 backoff 或等待 credential 时立即唤醒下一次尝试；
   - 必要时让 token cache 失效，但不无条件刷新造成 refresh storm。
4. 将 token refresh 的 single-flight、超时、失败退避和显式唤醒语义补齐。
5. 把 recovery phase 和最近一次失败信息提供给 `/v1/info`，供 UI 使用。
6. 增加单测、daemon 集成测试、broker 故障注入测试、durable replay 测试和真实
   macOS sleep/VPN 测试矩阵。
7. 保证同一时刻最多一个活动 worker generation，禁止 rebuild storm。

### 2.2 非目标

- 不修改 broker、NanoMQ、EMQX、Caddy 或 mqtt-auth 部署配置。
- 不重新实现 MQTT 协议，不替代 rumqttc 的正常 auto-reconnect。
- 不承诺笔记本真正睡眠期间仍执行后台重连；只能保证唤醒后立即恢复。
- 不把 `navigator.onLine` 当成 VPN 可用性的唯一依据。
- 不把本地 HTTP session 通道改成依赖 MQTT。
- 不清空 durable inbox/outbox 来“快速恢复”。
- 不扩大为进程级 daemon 重启；恢复目标仍然是 MQTT worker generation。

## 3. 目标架构

```text
macOS wake / visibility / focus / online
              |
              v
Desktop: probe daemon -> POST /v1/mqtt/recover
              |
              v
Daemon local HTTP route -> MqttRecoveryHandle
              |
              v
MqttSupervisor control channel
  - coalesce recovery signals
  - cancel current backoff
  - decide reuse token / refresh token
  - fence and rebuild generation
              |
              v
MqttWorker
  - owns MqttClient/EventLoop
  - restores subscriptions
  - durable inbox/outbox remains supervisor-independent
              |
              v
DaemonCommandExecutor
  - executes business handler
  - ACK durable inbox only after completion
```

### 3.1 增加 daemon recovery signal

在已有 `MqttSupervisor` control channel 上增加一个恢复控制消息，建议形态：

```rust
enum MqttControl {
    GenerationReady { generation: u64, reply: oneshot::Sender<bool> },
    Rebuild { reason: String },
    RecoverNow {
        reason: MqttRecoveryReason,
        reply: Option<oneshot::Sender<MqttRecoveryAccepted>>,
    },
}
```

客户端只提交 reason，不直接提交 `force_credential_refresh`。是否失效 token、是否
绕过 transient cooldown 由 supervisor 根据当前 phase、broker 错误分类和 credential
健康状态决定，避免一个带 admin token 的客户端把 refresh 变成可重复调用的放大器。

`RecoverNow` 必须是幂等的：

- 当前 generation 已 `GenerationReady` 且最近没有 sleep gap：返回 `AlreadyHealthy`；
- 当前 worker 存在但 disconnected/stalled：只允许一个 rebuild 请求；
- 当前 worker 为 `None`：将 `next_restart` 提前到 now，不新增 worker；
- 当前已有 recovery：合并 reason，不能再启动第二个 worker；
- 短时间内重复请求只增加计数和最近 reason，不重置 backoff 到 0 多次。

建议定义以下 reason，日志和测试都使用稳定值：

```text
Startup
VisibilityResume
LongVisibilityResume
NetworkOnline
UserRequested
Watchdog
CredentialRejected
```

### 3.2 本机 HTTP 接口

增加 daemon 本地接口：

```text
POST /v1/mqtt/recover
```

请求体：

```json
{
  "reason": "long_visibility_resume",
  "force_credential_refresh": false
}
```

响应只表示 signal 已被 supervisor 接受，不等待 broker CONNACK：

```json
{
  "accepted": true,
  "phase": "recovering",
  "generation": 8,
  "request_id": "..."
}
```

约束：

- 当前 HTTP server 是统一 TCP listener，不能只在文档里宣称“loopback”。实现时必须
  同时要求配置 bind 为 `127.0.0.1`/`::1`，并用 `ConnectInfo<SocketAddr>` 校验实际
  peer；非 loopback listener 直接禁用此 route 或返回 403。若后续需要远程管理，应
  另建经过独立鉴权的管理接口，不能复用本 endpoint；
- 继续使用现有 root/session token 认证和 `admin` scope；loopback 只减少暴露面，不能
  替代认证；
- 不把这个接口暴露到 Cloud API；
- handler 只向 supervisor 的 coalescing control handle 投递消息，不能直接持有或重建
  `MqttClient`；
- recovery handle 使用 `try_send` 或单独的 pending-slot：同一时刻只保留一个待处理
  signal，满载立即返回 503/`recovery_signal_unavailable`，不能用 `send().await` 排队；
- 对请求做独立 cooldown、reason 合并和审计计数；重复请求不能重复启动 worker 或
  refresh；
- route 单测验证 loopback peer、权限、重复请求、supervisor 已关闭和 malformed reason。

`HttpState` 保存一个与当前 supervisor 生命周期绑定的 `MqttRecoveryHandle`。daemon
重启 supervisor 时不能更换业务层 publisher，但可以更新 handle 内部的 control sender。
若复用统一 listener，`http::server` 必须改为 `into_make_service_with_connect_info`，
并在 recovery handler 中强制检查 peer；不能把这个检查留给调用方自觉遵守。

### 3.3 前端 wake/网络恢复接入

基于现有 `packages/app/src/stores/mqtt-reconnect.ts`、
`daemon-mqtt-status.ts`、`daemon-probe-signal.ts` 和已完成的 P2 probe 改造继续：

1. `visibilitychange -> visible`：
   - 先读取 daemon `/v1/info`；
   - 若距离 hidden 超过 `MQTT_SLEEP_WAKE_HIDDEN_MS`、document 被 discard，或 daemon
     报告 MQTT 非 ready，则调用 `POST /v1/mqtt/recover`；
   - 不因为普通 tab 切换无条件 rebuild。
2. `window.online`：
   - 作为快速提示，先 probe daemon，再发送 `NetworkOnline` recovery signal；
   - 不能仅凭该事件把 UI 设为 green；
   - VPN 可能不触发 `online`，所以 visibility/focus 和定期 daemon probe 仍保留。
3. window focus：
   - 保留 P2 的立即 probe；
   - 只有 probe 得到非 ready 且有 cooldown 时才发送 recovery signal；
   - 多个组件共享同一个 in-flight request。
4. 手动“Reconnect”按钮：
   - 改为调用同一个 daemon recovery 接口；
   - 继续保留桌面端 MQTT client 的 app-side reconnect，但不能只重建 app-side client。

前端 recovery 请求需要独立的 cooldown 和 in-flight coalescing：

```text
同一时刻最多一个请求
自动请求最短间隔 10s
用户明确点击可等待当前请求完成，但仍不能并发重建
```

## 4. Supervisor 恢复策略

### 4.1 状态模型

在现有 generation/heartbeat 状态上补充可观察 phase，不改变 stable publisher。必须
拆开三个容易混淆的身份：

- `worker_generation`：每次新建 worker 递增一次，worker 生命周期内不变；
- `connection_attempt`：该 worker 每次开始一次 transport 连接/收到新的 CONNACK
  递增一次；
- `ready_generation`：最近一次完成完整恢复的 `worker_generation`，没有 ready 时为
  `None`。

所有事件、日志、HTTP 快照和测试都使用这三个明确字段，不能再用 worker 重建前的
generation、transport generation 和 ready generation 混用一个数字。

phase：

```text
Starting
Connecting
TransportConnected
Restoring
Ready
Recovering
AuthRecovering
Backoff
Stopped
```

对外 `mqtt_connected=true` 的条件仍然只能是 `Ready`，不是 ConnAck。

`/v1/info` 增加一个整体发布的 MQTT snapshot，而不是分别读取多个 atomic：

```rust
struct MqttInfo {
    connected: bool,
    snapshot_version: u64,
    phase: String,
    worker_generation: Option<u64>,
    connection_attempt: Option<u64>,
    ready_generation: Option<u64>,
    last_error_code: Option<String>,
    last_error_at: Option<DateTime<Utc>>,
    last_recovery_reason: Option<String>,
    next_retry_at: Option<DateTime<Utc>>,
    last_ready_at: Option<DateTime<Utc>>,
}
```

snapshot 使用 `watch<Arc<MqttSnapshot>>`（或单一锁保护的不可变结构）整体替换，保证
`connected/phase/worker_generation/ready_generation` 是同一版本的快照。`/v1/info` 是
未鉴权接口，只暴露枚举化的 `last_error_code`（如 `dns_failure`、`cloud_timeout`、
`broker_auth_rejected`），原始错误只进入脱敏日志或需要鉴权的诊断接口。敏感 token、
完整 URL query、payload 和 refresh token 不能写入状态或日志。

### 4.2 RecoverNow 的处理顺序

1. 记录 `request_id`、reason、当前 phase、`worker_generation` 和
   `connection_attempt`。
2. 如果当前 generation 已 ready：
   - 检查最近 wall-clock gap 和 token expiry；
   - 无异常则只返回 `AlreadyHealthy`；
   - 有长 gap/过期 token 则进入受控 recovery。
3. 如果当前 worker 仍在 poll：
   - 标记当前 generation 为 fenced/recovering；
   - 停止接受发往旧 worker 的新 transport 请求；
   - 等待 `WORKER_STOP_TIMEOUT`，超时才 abort；
   - 保留 supervisor durable outbox。
4. 如果 worker 已退出或为 `None`：
   - 唤醒 credential/rebuild 尝试；
   - 不再叠加一个新的 worker。
5. token 获取成功后创建下一代 worker。当前实现中 `SubscriptionsReady` 之后仍由
   `DaemonServer` 持有 `SessionManager` 并执行业务 state restore，因此本方案不把这
   段责任错误地放进 worker。新增一个 generation-scoped `RestoreAttempt` 作为唯一
   owner，携带 `worker_generation + connection_attempt + cancellation token`，按现有
   顺序执行：

```text
ConnAck
 -> subscriptions restored + SUBACK
 -> daemon/team state restore
 -> durable outbox replay
 -> GenerationReady
```

6. `RestoreAttempt` 在每个副作用步骤前后检查 token 是否仍为当前代次。RecoverNow、
   watchdog Rebuild、worker exit 或 shutdown 会取消旧 attempt；旧 attempt 的延迟
   publish 和 `mark_generation_ready` 必须被 supervisor 以 worker/connection/attempt
   三重身份拒绝。只有当前 attempt 的 `GenerationReady` 能清零 rebuild backoff 并
   设置 `mqtt_connected=true`。

### 4.3 睡眠 gap 处理

不能只依赖 `Instant`。在 heartbeat/supervisor snapshot 中同时保留 wall-clock
`last_observed_epoch_ms`：

- 每次 supervisor/worker 取得调度机会时计算 wall-clock gap；
- gap 超过 `MQTT_WAKE_GAP_THRESHOLD`（建议 2 分钟）时标记 `WakeGapDetected`；
- 第一次恢复调度时立即执行一次 coalesced `RecoverNow`；
- 恢复请求不依赖 MQTT worker 自己发送 event；
- 正常睡眠期间不产生重建风暴，因为进程未运行；唤醒后只生成一个 recovery。

桌面端主动调用 recovery 是主要路径，wall-clock gap 是 daemon 独立兜底路径。

### 4.4 Backoff 与重建风暴

继续使用此前已有的重建退避，不另起一套计时器：

```text
5s -> 10s -> 20s -> 30s cap
```

规则：

- `RecoverNow` 只把下一次尝试提前到 now 一次；
- token refresh 连续失败时仍遵循共享 backoff；
- 多个 watchdog/recovery signal 合并；
- `GenerationReady` 后清零失败计数；
- 旧 worker 未 join 前禁止创建新 worker；
- 日志区分 `recovery_signal_count`、`worker_generation` 和 `credential_attempt`，
  不能用 poll error 次数代替连接尝试次数。

## 5. Credential refresh 协同

当前 `CloudApiBackend` 已有 token cache 和 `refresh_lock`，本次不删除它，但把
refresh coordinator 放到 Backend 内部，覆盖 MQTT supervisor、NATS、启动流程和普通
Cloud API 调用；不能只在 supervisor 外面再包一层 cooldown。补上以下行为：

1. **single-flight 结果共享**：同一时间多个调用等待同一个 refresh future/result，
   失败后不能每个 waiter 都再次提交同一个 refresh request。
2. **明确超时**：
   - refresh lock 等待有上限；
   - DNS/connect/request/response 各有可诊断的超时；
   - 超时后释放 single-flight 状态，允许后续 recovery 重试。
3. **失败退避**：
   - 网络/5xx/timeout 使用短退避；
   - 400/401 明确标记 terminal auth，交给既有 re-onboard 路径；
   - daemon 内部根据 `CredentialRejected` 等明确 reason 可绕过 transient failure
     cooldown 一次，但外部请求不能直接传入 force 参数，且不能绕过 single-flight。
4. **token 使用策略**：
   - transport 抖动且 cached token 仍有有效余量时，优先复用 token；
   - broker 明确 auth reject 或 token 已过期时才 invalidate；
   - 不能因为每次 TCP 失败都刷新 token。
5. **日志**：每次 credential attempt 记录开始、结束、耗时、分类、generation 和
   next retry；不记录 token 内容。

需要补充 `Backend` 能力时，优先添加语义明确的方法，例如：

```rust
async fn auth_token(&self) -> BackendResult<String>;
fn invalidate_cached_credential(&self);
fn cloud_auth_health(&self) -> Option<CloudAuthSnapshot>;
```

避免把通用 `Backend` 改成暴露 CloudApiBackend 内部 mutex。现有 `refresh_lock` 只能
保证同一时刻一个请求，不能保证第一个失败后所有 waiter 共享同一个失败结果；需要
增加可等待的 coordinator 状态（成功值、失败分类、失败时间、cooldown、terminal
auth latch、invalidate 版本和 shutdown/cancel），使后续 waiter 在同一轮直接得到
同一结果，而不是依次重新刷新。

## 6. Durable inbox/outbox 不变量

本次 recovery 必须复用现有 durable queue，不引入第二份队列：

### 6.1 Outbox

- `publish()` 成功只表示消息已被 daemon 持久化接受，不表示 Broker 已送达；
- worker generation 失败不能删除未收到 broker ACK 的 outbox item；
- generation rebuild 后按原 id 顺序 replay；
- 同一个 outbox id 的本地 ACK 必须幂等；Broker ACK 与本地 ACK 的崩溃窗口必须可重放；
- outbox item 不携带 generation 作为业务身份，但必须携带稳定的 `event_id`/`dedup_key`；
- 重复 recovery 请求不能导致重复 replay task。

当前 queue 中的 `ExactlyOnce` 枚举不能单独证明 exactly-once。本次对外只承诺按
delivery guarantee 实现的 at-most-once 或 at-least-once；若未来要承诺 exactly-once，
必须补齐 QoS2 状态机、进程重启恢复和消费端幂等协议。

### 6.2 Inbox

- worker 收到可靠 inbound 后先写 durable inbox；
- durable write 成功后才允许 MQTT ACK；
- durable inbox 记录必须保存协议层稳定的 `message_id`/`request_id`；相同的 MQTT
  redelivery 通过 `(source, message_id)` 去重，不能只依赖本地递增 durable id；
- command executor 根据明确的 `HandlerOutcome` 决定 disposition：成功才 ACK，
  可重试失败保留 item 并按退避重放，永久失败/非法消息进入 dead-letter 后再 ACK；
- executor 失败/daemon 被杀时 item 保留，下一代/下一次启动 replay；Retry 不能创建
  新的 durable id；
- handler 的副作用必须使用业务幂等键。没有端到端去重事务时，只承诺 at-least-once，
  不承诺业务 exactly-once；
- 慢 handler 不得阻塞 MQTT poll；
- inbox 满时进入明确 backpressure，不静默丢可靠消息。

### 6.3 崩溃窗口

实现和测试必须把以下窗口作为显式状态，而不是靠“通常不会发生”处理：

- inbox append 后、MQTT ACK 前退出：重连收到 redelivery 时用稳定 message id 去重；
- MQTT ACK 后、业务 ACK 前退出：本地 inbox item replay，handler 必须幂等；
- outbox append 后、发送前退出：启动后按 event id replay；
- Broker ACK 后、本地 outbox ACK 落盘前退出：重复发送允许发生，消费端用 event id
  去重；
- inbox ACK append 后、compact/rename 前退出：旧日志或新日志都必须恢复为同一集合；
- durable 文件最后一条 torn record 可丢弃，中间损坏必须拒绝启动并报警。

## 7. 测试计划

测试分为“无需真实网络的确定性测试”和“真实 broker/系统行为测试”。所有新增
测试都要保留现有 supervisor、durable queue 和 rebuild-storm 测试。

### 7.1 Rust 单元测试

位置建议：`apps/daemon/src/mqtt/supervisor.rs`、
`apps/daemon/src/mqtt/durable_queue.rs`、`apps/daemon/src/http/routes.rs`、
`apps/daemon/src/backend/cloud_api/mod.rs`。

必须覆盖：

1. `RecoverNow` 在 `Ready`、`Recovering`、`Backoff`、`worker=None` 下的状态转换。
2. 连续 20 次 recovery signal 只产生一个 active rebuild；与 watchdog/Rebuild 并发
   时仍只有一个 rebuild。
3. recovery signal 只提前下一次 retry，不把 backoff 无限重置为 0。
4. `GenerationReady` 清零 backoff；旧 worker generation、旧 connection attempt 和
   旧 restore attempt 的 ready 都被拒绝。
5. wake gap 只触发一次 coalesced recovery；shutdown 与 RecoverNow 并发不泄漏 task。
6. token refresh concurrent callers 共享成功结果，覆盖 supervisor、NATS 和普通
   Cloud API 调用者。
7. token refresh 失败时 concurrent callers 共享失败结果，不串行打几十次相同请求。
8. refresh timeout 后 lock/single-flight 能释放，下一次 recovery 可以成功。
9. 400/401 与 timeout/5xx 的 auth health 分类正确，terminal latch 能清除。
10. `/v1/mqtt/recover` 的 loopback peer、认证、参数、独立限流、重复请求和
    supervisor closed 行为；channel 满时立即 503。
11. 单一 MQTT snapshot 的版本和 phase/generation 一致，不出现 `connected=true` 与
    `Backoff` 混合快照；未鉴权 `/v1/info` 不泄露原始错误。
12. durable outbox 在 generation rebuild 后保持顺序和未 ACK item；验证
    `publish()` 返回的是 durable accepted，不是 broker delivered。
13. durable inbox 在 executor 成功、可重试失败、永久失败/dead-letter、进程重启后
    保持原 id 和 replay 顺序。
14. 相同协议 `message_id` 的 MQTT redelivery 只执行业务一次；没有 message id 的旧
    消息明确按 at-least-once 处理并记录诊断。
15. inbox append/ MQTT ACK、outbox append/Outgoing Publish、Broker ACK/本地 ACK、
    ACK append/compact rename 各崩溃窗口可恢复。
16. torn final record 可恢复，中间损坏记录拒绝启动；QoS0/QoS1 的 ACK 和 backpressure
    差异正确。

### 7.2 Daemon integration tests

使用现有 mock backend、mock HTTP server 和测试 MQTT broker，不能只验证函数返回值：

1. **正常启动**：`Starting -> Connecting -> TransportConnected -> Restoring -> Ready`。
2. **TCP/EOF 断联**：连接恢复在 recovery window 内完成，不 rebuild storm。
3. **broker 重启**：broker 终止后恢复，订阅和 state 恢复完成后才报告 connected。
4. **连续三轮 broker 故障**：每轮都能恢复，generation 单调递增，旧 event 被丢弃。
5. **TLS/502/DNS 失败**：自动退避，网络恢复后无需进程重启。
6. **认证拒绝**：只在明确 auth reason code 时 invalidate token；新 token 成功后恢复。
7. **Cloud API token refresh 不可用**：worker 保持 `AuthRecovering/Backoff`，不创建
   空 worker，不阻塞本地 HTTP；恢复接口到达后立即触发下一次尝试。
8. **RecoveryNow 期间发送消息**：消息进入 durable outbox，恢复后 replay，不丢失；
   验证 event id 在重复发送时保持不变。
9. **Inbound 慢处理**：handler 人为延迟 30 秒，MQTT worker heartbeat/poll 仍持续，
   inbox ACK 只在 handler 成功后出现；可重试失败按退避，不阻塞后续 poll。
10. **进程中止恢复**：分别在 inbox/outbox 的 ACK 临界点杀掉 daemon，再启动并验证
    replay、去重和顺序。
11. **Generation restore race**：state restore 尚未完成时同时触发 RecoverNow，旧
    attempt 被取消，不能发布旧 state 或报告错误 ready。
12. **重建风暴上限**：持续 cloud auth failure 时按 `5s/10s/20s/30s`，不存在并发
    generation 或每秒 rebuild。

### 7.3 前端单元测试

位置：`packages/app/src/stores/mqtt-reconnect.test.ts`、
`packages/app/src/stores/daemon-mqtt-status.test.ts` 及新增 daemon recovery client
测试。

必须覆盖：

1. 普通 focus 只 probe，不 rebuild healthy daemon。
2. 长时间 hidden/discarded 后发送一次 `POST /v1/mqtt/recover`。
3. `online` 和 visibility 同时到达时只发一个 recovery request。
4. VPN 场景没有 `online` 事件时，focus/probe 仍能触发 recovery。
5. recover 请求进行中重复事件被 coalesce。
6. daemon 返回 `AuthRecovering` 时 UI 不显示绿色。
7. daemon 变为 `Ready` 后 status banner 自动变绿，不依赖发送消息。
8. 手动 reconnect 调用 daemon recovery，而不是只 bump app-side MQTT client。
9. daemon HTTP 不可用时不把 app state 错误地标记为 MQTT ready。

### 7.4 真实故障注入矩阵

在本地 `pnpm tauri:dev:daemon` 环境保留手工验收记录，至少执行：

| 场景 | 注入方式 | 预期 |
|---|---|---|
| broker 进程终止 | 停止 NanoMQ/测试 broker | 自动恢复，订阅恢复，最多一个新 generation |
| broker 连续终止 3 轮 | kill/restart 3 次 | 每轮恢复，无风暴、无重启 daemon |
| TCP 黑洞 | 防火墙/代理丢包 | watchdog 发现，受控 rebuild，退避上限生效 |
| 502/TLS 错误 | 代理返回 502 或断 TLS | transport recovery 后可恢复 |
| DNS 暂时失败 | 临时修改解析/代理 | 网络恢复后无需点击发送消息 |
| cloud refresh 不可用 | 阻断 `/v1/auth/refresh` | UI 显示恢复中，outbox 保留，不创建大量 worker |
| VPN 断开后恢复 | 先断 VPN，后重连 VPN | focus/wake 后主动 recover，绿色状态自动出现 |
| 合上笔记本 | macOS sleep，保持 daemon 运行 | 打开后不发送消息也能恢复 |
| 睡眠期间 VPN 断开 | sleep 前断内网，醒来后再连接 | token/cloud API 恢复后 MQTT 自动 ready |
| UI 不操作 | 醒来后不点 banner、不建 session | 仍能在 bounded time 内恢复 |
| durable replay | recovery/kill 时有 pending inbox/outbox | item 不丢、顺序和 ACK 正确 |

“UI 不操作”必须拆成两组，避免被 focus、visibility 或 online 的隐式 signal 误导：

1. **daemon-only**：测试 harness 禁止调用 `/v1/mqtt/recover`，并记录
   `recovery_trigger=daemon_wake_gap` 或 `watchdog`；只验证 daemon 在重新获得调度
   后自行发现 wall-clock gap 并恢复。
2. **UI-assisted**：允许 `visibility`/`focus`/`online` signal，但必须记录具体
   `recovery_trigger`，验证前端只发一个 coalesced request 且不依赖发送消息。

两组都要记录 VPN 恢复、cloud token 成功、`TransportConnected`、
`SubscriptionsReady`、`GenerationReady` 时间，才能区分“网络恢复了但没有触发恢复”和
“恢复已触发但 credential/restore 失败”。确定性测试使用 fake clock 模拟长睡眠，真实
macOS sleep 只作为补充验收。

真实 macOS 验收需要记录：

- daemon 日志；
- 前端 MQTT diagnostic snapshot；
- `/v1/info` 每次 phase；
- `pmset -g log` 的 sleep/darkwake/wake 时间；
- VPN 恢复时间；
- `TransportConnected`、`SubscriptionsReady`、`GenerationReady` 时间。

### 7.5 验收阈值

在 daemon 已被唤醒且 cloud API/VPN 已真实可达的前提下：

- UI-assisted 场景中，不操作发送消息，MQTT 在一次 coalesced recovery signal 后恢复
  到 `Ready`；daemon-only 场景中不允许有 recovery endpoint 请求；
- 从 recovery signal 到 `Ready` 的本地处理目标不超过 30 秒，网络/认证请求耗时
  单独记录；
- 不产生第二个并发 worker，且 `worker_generation`、`connection_attempt`、
  `ready_generation` 的含义和日志一致；
- durable inbox/outbox 可靠 item 不丢失；
- UI 在 `Ready` 事件或 probe 后变绿，不依赖发送消息；
- cloud API 不可达时必须显示/记录原因，不能伪装成“已连接”。

## 8. 实施顺序

### 第一步：先接 daemon recovery signal

- 增加 `MqttControl::RecoverNow` 和 `MqttRecoveryHandle`；
- 增加强制 loopback peer 校验的 `/v1/mqtt/recover`，使用 coalescing `try_send` 和
  独立限流；
- 增加单一版本化 MQTT snapshot；`/v1/info` 暴露 phase、明确命名的三种代次、错误码
  和 next retry，不暴露原始错误；
- 固定 `SubscriptionsReady -> GenerationReady` 的 `RestoreAttempt` owner、取消和
  stale completion 校验；
- 保留现有 supervisor、worker、publisher 和 durable queue 行为；
- 补 route/supervisor 单测。

### 第二步：补 token single-flight failure policy

- 共享 refresh result；
- lock/request timeout；
- transient failure cooldown；
- explicit recovery 一次性唤醒；
- 统一覆盖 MQTT、NATS、启动流程和普通 Cloud API 调用方；
- 补 cloud backend 单测。

### 第三步：接前端 wake/focus/online

- 扩展现有 `mqtt-reconnect`，不要新建第二套 reconnect store；
- 所有事件通过 shared probe/recovery client；
- 手动 reconnect 复用同一接口；
- 补前端 coalescing 和状态测试。

### 第四步：补 sleep gap daemon 兜底

- heartbeat 增加 wall-clock observation；
- 首次恢复调度检测 gap 并合并 recovery；
- 验证与 watchdog 不重复触发。

### 第五步：执行故障注入和 durable replay 验收

- 先跑确定性单测/集成测试；
- 再跑多轮 broker failure、cloud auth failure；
- 最后跑 macOS sleep/VPN 手工矩阵；
- 根据日志补齐 attempt duration、phase、recovery reason 和 trigger 来源；
- 完成 message id/dedup、HandlerOutcome、dead-letter 以及崩溃窗口测试后，才允许把
  durable replay 标记为完成。

## 9. 回归保护与禁止事项

- 不得恢复 `server.rs` 中直接调用 `eventloop.poll()` 的旧主循环。
- 不得让 `DaemonCommandExecutor` 在 MQTT worker 中运行。
- 不得在 recover endpoint 中直接构造 `MqttClient`。
- 不得在未强制 loopback peer 校验时把 `/v1/mqtt/recover` 暴露在统一非 loopback
  listener 上。
- 不得用 UI 的本地 `/v1/auth/exchange` 成功推断 cloud token 或 MQTT 已恢复。
- 不得把 `navigator.onLine` 作为 VPN 已恢复的证明。
- 不得每次 focus 都强制刷新 token/重建 generation。
- 不得在 token refresh 失败时启动多个并发 refresh。
- 不得在 generation rebuild 时删除 durable inbox/outbox。
- 不得把本地递增 durable id 当成 MQTT redelivery 去重键。
- 不得把 `publish()` 的 durable accepted 语义写成 Broker delivered 或 exactly-once。
- 不得让旧 `RestoreAttempt` 在新 generation 中继续发布状态或报告 ready。
- 不得通过进程重启掩盖 worker/token recovery 的问题。

## 10. 完成定义

本方案完成的条件：

1. 旧 MQTT 架构改造的已有测试全部通过。
2. 新增 recovery endpoint、supervisor、credential、frontend、generation race 和 durable
   replay 测试全部通过。
3. 三轮 broker 连续故障无 rebuild storm。
4. cloud token refresh 持续失败时没有并发 refresh 爆炸，恢复后能自动继续。
5. daemon-only 和 UI-assisted 两组睡眠/VPN 测试都通过：前者不调用 recovery
   endpoint，后者不点击、不发送消息也能自动进入 `Ready`。
6. UI status 与 daemon `/v1/info` 一致，不再出现“消息能发但横幅持续假断联”或
   “横幅变绿但 subscriptions/state 尚未恢复”。
7. 日志能完整回答：何时发现断联、触发来源是什么、token 是否成功、哪个
   `worker_generation/connection_attempt` ready、durable item 是否 replay，以及
   是否发生了 redelivery/dedup。

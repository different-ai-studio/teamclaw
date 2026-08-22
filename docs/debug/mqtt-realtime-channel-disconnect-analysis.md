# MQTT 实时通道断连问题核实报告

> 日期：2026-08-20
> 现象：桌面 App 侧栏反复出现 "Agent real-time channel disconnected - Local agent is up, but its MQTT link is down" 琥珀色警告。
> 涉及组件：桌面前端（`packages/app`）、本地 daemon（`apps/daemon`）、服务端（`accounting-copilot-test-sg`：Caddy + NanoMQ + mqtt-auth + mqtt-watchdog）。

---

## 一、结论摘要

侧栏警告表示：**本地 daemon 的 HTTP 服务仍可访问，但 daemon 自报的 MQTT 连接为断开状态**。

本次通过代码走读、本机 `~/.amuxd/logs/amuxd.log` 和测试环境容器日志核实后，结论如下：

1. **90 秒恢复窗口真实存在。** rumqttc 遇到部分网络/TLS 错误后没有完成自动重连，daemon 最终依靠 `MQTT_DISCONNECT_REBUILD = 90s` 强制重建 MQTT client。
2. **“broker 因 JWT 到期每小时踢人”不成立。** 2026-08-20 的 daemon 日志没有出现 `ConnectionRefused`；服务端 mqtt-auth 只在 CONNECT 时检查 JWT，不会在已建立的连接上按 `exp` 定时踢人。
3. **约 55 分钟的连接时长主要来自 daemon 主动重连。** daemon 明确在 JWT 到期前 5 分钟主动断开并换取新 token，这与 Caddy 中约 3300 秒的记录一致。
4. **NanoMQ 的 `Object closed` 刷屏主要是健康探针噪音。** watchdog 和容器健康检查都会完成 WebSocket Upgrade 后立即销毁 socket，不能据此推断所有客户端被 Caddy 或 NanoMQ 高频异常断开。
5. **休眠后永久半开连接尚未被证实。** rumqttc 0.24.0 自带 PingResp 超时检测；如果要认定其在休眠场景失效，需要抓取复现时的连续 daemon 日志和网络状态。
6. **前端恢复感知存在缺口。** daemon 状态依赖 20 秒定时轮询；窗口重新可见时没有直接触发 `requestDaemonProbe()`，因此已恢复状态可能继续显示到下一次有效轮询。

因此，当前最准确的一句话是：

> **部分网络/TLS 断连后 rumqttc 自动重连未成功，daemon 最长等待约 90 秒才强制重建；前端将 daemon 自报的断开状态显示出来，并可能在后台恢复后额外滞后。**

---

## 二、已确认的现场证据

### 2.1 daemon 日志统计

2026-08-20 本机 daemon 日志中：

- `MQTT transient error`：50 条；
- `MQTT disconnected too long`：7 次；
- `MQTT connection refused`：0 次；
- `JWT nearing expiry` 主动重连：4 次；
- 主动 JWT 重连通常约 1 秒内完成。

原报告写“一天 8 次非计划断连”，但表格实际只有 7 条，日志中的 90 秒兜底记录也是 7 次。

主要的 90 秒兜底事件：

| 时间（UTC） | daemon 首个错误 | 后续行为 |
|---|---|---|
| 01:47 | DNS 解析失败 | 约 90 秒后强制重建 |
| 04:05 | connection closed by peer | 约 90 秒后强制重建 |
| 06:11 | connection closed by peer | 约 90 秒后强制重建 |
| 06:30 | TLS UnexpectedEof | 约 90 秒后强制重建 |
| 07:37 | I/O: not connected | 约 90 秒后强制重建 |
| 08:00 | connection closed by peer | 约 90 秒后强制重建 |
| 09:01 | connection closed by peer | 约 90 秒后强制重建 |

其中存在明确的非认证原因：

- 04:00 UTC 附近本地 daemon 收到 shutdown signal，随后进程重新启动，不能算作单纯 MQTT 自愈耗时；
- 08:00 UTC 对应服务端 16:00（UTC+8）附近，测试容器中的 NanoMQ 被 supervisor 正常停止，属于服务重启影响；
- 其他事件的日志是 DNS、TCP、TLS 或未连接错误，没有认证拒绝证据。

### 2.2 Caddy `/mqtt` 连接时长

测试容器当前可用的 5 份 Caddy 日志中共找到 54 条 `/mqtt` WebSocket 记录，全部返回 101：

| 时长区间 | 数量 |
|---|---:|
| 1～60 秒 | 6 |
| 60～600 秒 | 9 |
| 600～3000 秒 | 13 |
| 3000～3350 秒 | 15 |
| 3500～3560 秒 | 11 |

长连接峰值包括：

- 3299～3300 秒：12 条；
- 3539～3540 秒：8 条。

3300 秒正好是 55 分钟，与 daemon 的 `proactive_reconnect_delay()` 一致，属于客户端主动重连的直接证据。

3540 秒附近的连接可能来自其他客户端的 token 刷新周期、网关连接寿命或其他客户端策略。Caddy access log 只记录连接关闭后的总时长，**不能判断关闭动作由客户端、网关、Caddy 还是 NanoMQ 发起**，因此不能将该聚类直接归因于 JWT 到期。

### 2.3 mqtt-auth 的能力边界

`mqtt-auth.mjs` 在 NanoMQ 发起 MQTT CONNECT 鉴权时：

1. 校验 JWT HS256 签名；
2. 检查 `exp` 是否已过期；
3. 返回 200 或 403。

这是一次性的 CONNECT 鉴权。连接建立后 mqtt-auth 不持有连接，也没有按 JWT `exp` 定时关闭连接的逻辑。

因此：

- 过期 JWT 会使**新的 CONNECT**被拒绝；
- 现有连接不会被 mqtt-auth 主动按时踢下线；
- 如果要证明自动重连使用旧 JWT 被拒绝，需要 mqtt-auth 输出 clientId、允许/拒绝和拒绝原因。目前日志没有这些字段。

### 2.4 NanoMQ `Object closed` 日志

线上 `nanomq.log` 在约 3 小时内出现约 1800 条：

```text
wstran_pipe_recv_cb: recv aio error Object closed
```

测试容器同时存在两类探针：

- `mqtt-watchdog.sh` 每 10 秒执行一次 MQTT WebSocket Upgrade；
- 容器健康检查约每 15 秒调用 `/healthz`，内部也执行 MQTT WebSocket Upgrade。

探针在收到 101 后立即 `socket.destroy()`，NanoMQ 因而记录 `Object closed`。数量和时间节奏与日志高度吻合。

结论：日志噪音真实存在，但它主要说明探针主动关闭连接，**不说明所有业务客户端都在异常断连**。

---

## 三、代码核实

### 3.1 daemon 的真实恢复逻辑

`apps/daemon/src/daemon/server.rs` 当前行为：

1. `ConnectionRefused`：立即标记断开、作废缓存凭证并返回外层循环；
2. 其他 transient error：保留 rumqttc client，等待其自动重连；
3. `mqtt_connected == false` 持续 90 秒：作废凭证并强制整体重建；
4. JWT 进入提前 5 分钟刷新窗口：主动断开并整体重建。

所以“遇到 `ConnectionRefused` 仍等待 90 秒”与当前代码不符。真正的问题是：

> 某些 transient error 后 rumqttc 没有在合理时间内恢复，而 daemon 对这类错误统一等待 90 秒才升级为整体重建。

### 3.2 rumqttc 已有链路活性检测

项目使用 rumqttc 0.24.0。其状态机记录 `last_incoming` 和 `await_pingresp`：

- 每个 keepalive 周期发送 PingReq；
- 上一次 PingReq 未收到 PingResp 时返回 `StateError::AwaitPingResp`；
- `EventLoop::poll()` 遇到网络或状态错误后调用 `clean()`；
- 后续继续 poll 会重新建立网络连接。

因此以下说法不准确：

- “rumqttc 对半开连接没有检测”；
- “CONNACK 通用错误后继续 poll 一定会无限挂起”。

额外增加 daemon 层 activity watchdog 可以作为防御性措施，但在拿到休眠复现日志前，不应列为已确认根因。

### 3.3 前端状态显示

前端状态来源：

- 本地 HTTP 探活；
- `GET /v1/info` 返回的 `mqtt_connected`；
- 20 秒共享轮询。

前端不会制造 MQTT 断连。轮询带来的额外影响是：

- 断连可能延迟最多一个轮询周期才显示；
- daemon 恢复后，警告可能额外保留最多一个有效轮询周期；
- App 长期处于后台时，WebView timer 可能被冻结更久。

“20 秒轮询把秒级断连放大成 1～2 分钟”不准确。日志中的约 95 秒窗口主要来自 daemon 的 90 秒兜底。

当前 App 自身 MQTT 恢复逻辑已经监听 `visibilitychange`，但 daemon 状态轮询没有在 `focus` 或窗口重新可见时直接调用 `requestDaemonProbe()`。点击黄色警告会主动调用该函数，因此“点击后立即变绿”可以由状态刷新缺口解释。

### 3.4 agent 药丸状态

当前 `session-agent-ui-state.ts` 定义了 10 秒 connecting timeout：

- 超时后本地 agent 转为 `offline`；
- session runtime 场景转为 `runtime-error`；
- 本地 agent 还会通过 HTTP 获取 daemon 的 `mqtt_connected` 和可达性证据。

因此“MQTT 不更新会让药丸永久停在 connecting”与当前代码不符。若现场仍永久显示“连接中”，需要记录实际 UI state 输入和客户端版本，不能仅凭 MQTT presence 推导。

---

## 四、问题清单

| # | 状态 | 问题 | 影响 | 建议 |
|---|---|---|---|---|
| P1 | 机制已确认，策略待灰度 | transient 网络错误后最长等待 90 秒才强制重建 | 约 1～2 分钟可见告警、消息暂不可用 | 先补齐自动重连日志；首版建议将兜底改为可配置的 30 秒并观察重连抖动 |
| P2 | 已确认 | daemon 恢复后前端可能未及时重新探活 | 黄色警告在后台恢复后继续显示 | 在 `focus` / `visibilitychange` 时调用 `requestDaemonProbe()` |
| P3 | 已确认 | NanoMQ 健康探针产生大量 warn 日志 | 掩盖真实异常、增加排查成本 | 调低该 transport 日志级别，或对探针关闭日志做过滤 |
| P4 | 待复现 | 休眠唤醒后是否存在 rumqttc 未检测到的永久连接失活 | 可能需要重启 daemon | 复现时保存 daemon 连续日志、`mqtt_connected`、PingResp/错误和网络切换时间 |
| P5 | 待确认 | 约 3540 秒连接聚类的关闭方未知 | 可能存在网关或其他客户端周期策略 | 增加 Caddy/NanoMQ/clientId 关联日志，检查网关 WebSocket 最大连接时长 |
| P6 | 低优先级 | daemon 启动时 HTTP 先于 MQTT 就绪 | 启动瞬间短暂告警 | 可接受，或增加启动宽限/告警去抖 |

以下原问题应移除：

- “JWT 到期后 broker 每小时踢连接”；
- “`ConnectionRefused` 后仍用旧凭证等待 90 秒”；
- “CONNACK 通用错误分支必然无限挂起”；
- “rumqttc 没有 PingResp/半开连接检测”；
- “药丸因 connectingSince 机制永久停在连接中”。

---

## 五、建议的验证补强

为了确定剩余 transient error 的关闭方，建议补充以下不含敏感 token 的日志：

1. mqtt-auth：时间、clientId、allow/deny、deny reason；
2. daemon：每次自动重连尝试的阶段、错误、累计次数、使用凭证的 expiry；
3. NanoMQ：clientId 上下线原因，而不仅是 `Object closed`；
4. Caddy：连接开始/结束时间、remote IP、upstream close error；
5. 休眠复现：睡眠和唤醒时间、网络 online 事件、首次 PingReq/PingResp 或 timeout。

在这些证据齐备前，应将根因描述为“网络/TLS 断连后的自动重连恢复不稳定”，而不是 JWT 到期或休眠半开连接。

## 六、修复方案与落地顺序

### 6.1 先修已确认、低风险的问题

**第一步：P2 前端主动探活。**

在 daemon 状态 hook 中监听 `window.focus` 和 `document.visibilitychange`，窗口重新获得焦点或重新可见时调用 `requestDaemonProbe()`。现有共享 probe 已经做了并发合并，因此不会因为定时轮询和窗口事件同时到达而发起两次 HTTP 请求。补一个 hook 测试，验证事件触发探活、卸载后移除监听，以及 probe 失败时状态仍能正确更新。

这只能消除“daemon 已恢复但横幅仍是黄色”的显示滞后，不能修复 MQTT 链路本身。

**第二步：P3 清理探针日志。**

给 watchdog/health check 使用独立的 client 标识或 User-Agent，在 NanoMQ transport 日志侧仅降低或过滤这类主动关闭连接的记录。业务 client 的 `Object closed` 仍须保留，不能按整类关键字全部吞掉。

### 6.2 P1 先观测，再缩短兜底窗口

90 秒等待是已确认的恢复策略问题，但“改成连续 N 次失败”目前缺少可靠的“每次自动重连尝试”边界；不能把每次 `poll()` 错误简单当成一次尝试。第一版按以下方式落地：

1. 为每次自动重连记录开始、失败、成功、累计断开时长、最终 rebuild 原因和连接代次；日志中只记录错误类型和 token expiry 时间，不记录 token 内容。
2. 保留 rumqttc 的自动重连机制，不对 `mqtt.eventloop.poll()` 加 `tokio::timeout`。当前代码已明确说明，取消 poll future 会丢弃进行中的 TLS/TCP 状态，可能制造新的连接风暴。
3. 将 `MQTT_DISCONNECT_REBUILD` 提取为可配置常量，首版默认从 90 秒调整为 **30 秒**。30 秒是折中值：减少用户等待，又保留一次 keepalive/网络恢复机会；上线后观察 rebuild 次数、ConnAck 成功率、重复连接和消息恢复情况，再决定是否进一步调整或改为基于失败次数。
4. 只有收到 `ConnAck` 后才清零断开计时和失败计数；重建前继续保留当前“暂停发送、重建时刷新凭证”的行为。

这一步解决的是“断了以后恢复太慢”，不是“连接为什么会断”。若 30 秒导致网络抖动期间重建次数明显上升，应回滚阈值，不能继续靠猜测调小。

### 6.3 P4 先加诊断护栏，再针对性修复

“02:09 到 03:52 没有 MQTT 活动，说明 `tokio::select!` 被 sock handler 卡住”是合理假设，但尚未确诊。P4 不直接对所有 handler 粗暴加 timeout，因为 timeout 会取消 future；对于已经产生部分副作用的写操作，可能造成状态半完成或调用方重试重复执行。

诊断版建议包含：

1. 给每个 `SockCommand` 记录 command 名称、开始时间、结束时间和耗时；超过阈值时输出 warning。
2. 增加独立 watchdog，记录 event loop 最近一次进度、当前正在处理的 command，以及 MQTT 最近一次 `poll`/`ConnAck`/错误时间。watchdog 必须运行在 event loop 之外，才能观察 event loop 自身是否停转。
3. 对只读且明确可取消的 handler 才加局部 timeout；有副作用的 handler 优先拆成后台 task + reply channel，或把超时放到其内部可恢复的边界。
4. 用睡眠/唤醒、断网/恢复、broker 重启三类场景复现，至少拿到一次“handler 超时”或“event loop 停顿但无 handler”的证据后，再做正解。

### 6.4 暂不处理

P5 的 3540 秒连接簇还缺少连接归属和关闭方证据；P6 的启动时 HTTP 先于 MQTT 只造成短暂状态差异。两者不应和本轮恢复链路修复混在一起。

### 6.5 验收标准

- P2：窗口恢复可见/获得焦点后立即触发一次探活；并发事件只产生一个 in-flight probe。
- P1：模拟 DNS、TLS、broker 重启后，正常自动重连仍能工作；无法恢复时不超过 30 秒进入 full rebuild，且没有高频建连风暴。
- P4：复现期间能区分“网络/rumqttc 不再返回”与“sock handler 阻塞 event loop”；没有证据前不把休眠半开连接写成根因。
- P3：探针噪音下降，同时真实业务连接关闭仍可检索。

**最终优先级：P2 → P1 观测与 30 秒灰度 → P4 诊断复现 → 针对性拆分/超时 → P3 日志治理；P5/P6 暂缓。**

## 七、本轮代码落地后的结论

- P2 已落地：桌面端启动、获得焦点和重新可见时会主动探活，降低“daemon 已恢复但界面仍显示断开”的假象。
- P1 已落地为 30 秒 transport recovery window。MQTT worker 在窗口内继续使用 rumqttc 自动恢复，超时后由独立 supervisor 停止旧 worker 并创建新 generation；不再依赖业务主循环里的 90 秒计时器。
- MQTT worker 已与业务 command executor 解耦，worker 只负责 `poll()`、订阅、收发和 durable inbox/outbox；慢业务 handler 不再直接冻结 MQTT worker。
- 这解决的是“断线后恢复路径过慢或 worker 失活时没有独立自愈边界”，不是对 P4 根因的事后证明。P4 仍需 broker 重启、TCP/TLS 故障和睡眠唤醒故障注入来确认现场是否存在永久失活。
- 因此当前最准确的根因表述仍是：**网络大概率正常时，桌面端看到的断连可能是状态刷新滞后；真实网络抖动或 MQTT worker 失活时，旧实现的恢复升级边界过长且依赖同一事件循环。** 不能把问题归咎于 JWT 到期或 NanoMQ 探针日志。

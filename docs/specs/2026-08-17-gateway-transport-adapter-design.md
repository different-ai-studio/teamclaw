# 网关收拢为传输适配器 — 设计

关联：#933（问题与清单）、#934（已合并的止血改动）

## 背景与问题

网关不是"以参与者身份接入 session"，而是 session 运行时的第二套实现。#933 已经量化过：`crates/teamclu-gateway` 17,293 行 / 25 文件，7 个渠道文件约 11,350 行里真正的协议部分只占一半，另一半是被抄了 7 遍的会话语义。

症状不是零星 bug，而是同一类 bug 反复出现。#934 修的三个——整轮不落库、从不广播、出站附件用错 kind——都是"语义写在渠道里"的必然产物：写一遍就只对一个方向、一个渠道成立。

**判据**（本设计全程用它裁剪）：一段代码换成另一个聊天平台后仍然成立，它就不该待在渠道适配器里。

## 现状：为什么会长成这样

### 病根一：网关把 agent 的输出流劫走了

消息写入本来就是 **agent 侧**的事，daemon 里也早就有完整实现：

```
ACP 事件 → poll_events → handle_acp_event → TurnAggregator → emit_agent_message
                                                              ├─ session/{id}/live 广播
                                                              ├─ 本地 TOML
                                                              └─ 云端 messages（仅 turn-final）
```

`TurnAggregator` 负责回合切分、工具调用处会 mid-turn flush、打 `turn_id`、区分 interrupted / no_final_reply；`emit_agent_message` 负责广播、落库、盖 model、写 `reply_to_message_id`、必要时推进 catchup cursor。

网关一条都用不上——因为它把这条流劫走了。`AmuxdAgentHandle::run_turn` 调 `checkout_turn_for_acp`，那个函数会 **把运行时的 `event_rx` 从 handle 里 `take()` 出来**（`manager.rs:1334`）。源码自己写着后果（`runtime/manager/poll.rs:5`）：

> Agents whose `event_rx` is checked out for a gateway turn are skipped.

也就是说：**一轮网关 turn 期间，daemon 的事件泵是瞎的**，aggregator 与 `emit_agent_message` 一行都不跑。网关自己收完 ACP 事件、拼出文本，最后调一次 `record_agent_reply` 写一条简化版的行——没有 turn_id、没有 model、没有 reply_to、没有 cursor、没有 mid-turn flush、没有 interrupted 状态。

#933 的三个症状是同一个原因：不是"网关忘了广播"，而是**负责广播的那段代码在网关 turn 里根本没有机会运行**。两套实现也不是并存，是靠"谁抢到 event_rx"互斥——一个接线上的巧合，不是设计。

结论：写入不该"从网关搬到一个新服务"，而是**网关本来就不该驱动 turn**。它该把消息交进去，然后像任何客户端一样订阅这个 session 的产出，把它渲染到聊天里。

### 病根二：三个写入方，各拼各的

| 写入方 | 落库 | 广播 | 去重 | 附加动作 |
|---|---|---|---|---|
| 桌面端 | outbox → `POST /v1/sessions/:id/messages` | 客户端自己 publish `message.created` | 服务端 id 幂等 | 乐观 UI 先行 |
| cron | `backend.insert_message`（spawn 出去） | `publish_live_message` | `should_process_message` 先 claim | 另写一份本地 TOML `persist_message` |
| 网关 | `ChannelStore::record_*` → `insert_gateway_*` | #934 之后才有（`GatewayLiveNotifier`） | 同上（#934 抽出的 `MessageDedup`） | 附件仅入站 |

三份代码拼三次 metadata、各自决定何时写、各自决定要不要广播。cron 甚至多写一份本地 TOML。

### 病根三：两个 trait 的形状

网关能"做很多不该做的事"，是因为接口把这些权力递到了它手上：

- **`ChannelStore`**（8 个方法）：ensure_session / record_message / record_agent_reply / record_*_with_attachments / upload_attachment / add_participant。**每个渠道自己决定调哪个、什么时候调、内容怎么拼。**
- **`AgentHandle`**（18 个方法）：既有 turn 驱动（send_prompt / streamed / cancel），又有会话管理（list_sessions / switch_session / start_new_session）、工作区管理（list_workspaces / set_workspace）、模型管理（list_models / set_model / current_model）、命令广告（available_commands / send_slash_command）、成员（list_participants）。

一个"传输适配器"不需要 `set_workspace`。它现在有，所以 `/workspace <n>` 就顺手写了 `daemon.toml`。

## 已确认的设计决策

1. **crate 依赖方向不变**：`teamclu-gateway` 仍是被 `amuxd` 依赖的下层 crate，接口（trait + 数据类型）定义在 gateway crate，实现留在 daemon。这是现有形状，不必反转，改的是接口的**宽度**。
2. **桌面端不动**。它的路径按定义就是目标形态；本设计统一的是 daemon 内部的语义，不跨进程重构客户端。
3. **不追求删掉渠道代码的行数**，追求删掉**重复的语义**。协议部分（长连接、签名、分片、卡片/流式帧）该多长就多长。
4. **每一步都能单独发布**。不接受"全部改完才能验证"的迁移。

## 目标分层

```
┌─────────────────────────────────────────────────────────┐
│ A. 渠道适配器   crates/teamclu-gateway                   │
│    协议 I/O、签名解密、消息解析、渲染（流式帧/卡片/MIME） │
│    身份映射（渠道用户 → external actor）、凭据配置        │
│    —— 每平台一份，互不相同，这里长是应该的                │
└───────────────┬─────────────────────────────────────────┘
                │  ConversationPort（窄接口，见下）
┌───────────────▼─────────────────────────────────────────┐
│ B. 会话服务     apps/daemon（新层，唯一实现）             │
│    会话解析（binding → session，一份映射）                │
│    消息写入 + 广播 + 去重 claim + 附件入库（双向）        │
│    turn 排队与生命周期                                    │
│    命令语义（/model /workspace /new /sessions …）         │
└───────────────┬─────────────────────────────────────────┘
                │
┌───────────────▼─────────────────────────────────────────┐
│ C. 运行时       apps/daemon/src/runtime                  │
│    spawn / attach / ACP 事件 / 流式                       │
└─────────────────────────────────────────────────────────┘
```

cron 与网关都接 B。桌面端经由 Cloud API + MQTT 与 B 达成同样的语义（不共用代码，共用契约）。

**关键：B 层不是"给网关调用的写入服务"，而是把网关摘出 turn 驱动。** 消息写入留在 agent 侧既有的
`TurnAggregator` → `emit_agent_message` 这条路上；网关不再 `checkout_turn_for_acp`，事件泵因此在
网关会话上也正常运行。网关变成"投递 + 订阅"：交进一条消息，然后订阅这个 session 的产出去渲染，
和桌面端订阅 `session/{id}/live` 是同一件事。

这样一来，网关会话**免费得到**今天没有的东西：mid-turn flush（工具调用处就出字）、turn_id、model
戳记、reply_to、interrupted / no_final_reply 状态、catchup cursor。这些不是新功能，是 agent 侧
一直在做、只是网关把流劫走后没人跑的部分。

## 接口设计

### 归一化的数据类型（gateway crate 定义）

```rust
/// 渠道收到的一条消息，已经解完协议、认完身份。
pub struct InboundMessage {
    pub binding: String,              // 聊天的稳定 URI
    pub sender: ExternalIdentity,     // 渠道用户 → 由服务侧 upsert 成 external actor
    pub text: String,
    pub attachments: Vec<InboundAttachment>,  // 只带字节与文件名，不含存储决策
    pub external_id: Option<String>,  // 平台消息 id，用于幂等
    pub reply_target: ChatTarget,     // 回哪儿（DM / 群 / 线程）
}

/// 服务侧要渠道渲染出去的东西。
pub enum Outbound {
    Frame(ReplyFrame),                // { text, finished } —— 流式与终帧同一形状
    Attachment(AttachmentRef),        // 已入库的附件，渠道只管把它送出去
}
```

`InboundAttachment` 刻意只有字节和文件名：bucket 路径怎么拼、内联图片阈值多大、要不要留本地缓存，全是 B 层的决定。

### ConversationPort：渠道能做的全部事情

> **状态：deliver + subscribe 的形状经讨论后推荐改为"服务推、适配器渲染"，见下节。此处保留两版对照，未最终拍板。**

初版（渠道订阅）：

```rust
async fn deliver(&self, msg: InboundMessage) -> Result<(), PortError>;
async fn subscribe(&self, binding: &str) -> Result<ReplyStream, PortError>;
```

问题在于 `subscribe` 把五个难题分发给了 7 个适配器，每一条都要写 7 遍——正是本设计要消灭的东西：

| 难题 | naive 实现的后果 |
|---|---|
| 游标 / 竞态 | subscribe 晚于 deliver → 丢掉这一轮开头的帧 |
| `broadcast` lag | 慢渲染者 `Lagged`：丢中间帧无所谓，**丢终帧就是气泡永远收不了口** |
| 哪些事件是我的 | 同一 session 桌面端也可能在提问，需按 turn_id 过滤 |
| turn 何时结束 | 没有显式结束事件，只能靠超时猜 |
| 状态提示过滤 | 直接渲染就会把 `[Turn interrupted by user]` 推进企微（`TurnAggregator::is_agent_facing_status_notice` 明确说渠道 UI 不得当回复渲染） |

### 推荐形状：服务推，适配器只渲染

```rust
// 端口：渠道能做的——没有 subscribe
#[async_trait]
pub trait ConversationPort: Send + Sync {
    async fn deliver(&self, msg: InboundMessage) -> Result<Delivered, PortError>;
    async fn command(&self, cmd: SlashCommand) -> Result<Option<String>, PortError>;
    async fn outbound(&self, binding: &str, out: Outbound) -> Result<(), PortError>;
}

/// deliver 的结果要说清楚发生了什么：落库成功 ≠ 起了一轮。
pub enum Delivered {
    TurnStarted { turn_id: String },
    Queued,                       // 已落库但未起 turn（未 @ agent，silent-queue）
    Ignored { reason: String },
}

pub enum Outbound {
    Thinking { turn_id: String },                          // 占位帧
    Reply { turn_id: String, text: String, finished: bool },// 累计文本，非增量
    Attachment(AttachmentRef),
    Notice(NoticeKind),                                     // 服务侧已本地化
}
```

三个决定及其理由：

1. **累计文本而非增量**：WeCom 靠同 id 覆盖气泡，`send_prompt_streamed` 今天给的也是累计值；增量会逼每个适配器自己维护缓冲。
2. **`Thinking` 由服务发，不由渠道猜**：`deliver` 成功 ≠ turn 开始。未 @ agent 的消息会被 silent-queue（`messaging.rs:786`），今天网关照样弹"正在思考"然后永远等不到回复。
3. **`Notice` 类型化且已本地化**：适配器拿不到英文原文，也就不可能误渲染成回复。

服务侧承担的（因此只写一遍）：游标、lag 策略、按 binding 串行与背压（积压只保留最新帧——今天 WeCom `drain_to_latest` 的策略搬进来）、turn 结束映射、状态提示过滤。

### 渠道差异用投递策略表达，不是第二套 API

```rust
pub enum DeliveryPolicy { Streaming, FinalOnly }
```

WeCom / Discord / KOOK 用 `Streaming`；**邮件用 `FinalOnly`**——邮件没有"编辑上一封"，中途帧对它是噪音。今天邮件能工作是因为它同步等 `send_prompt` 返回；换成推送模型后这个差异必须显式，否则一轮会发出 5 封邮件。

### 渠道侧要实现的

```rust
#[async_trait]
pub trait ChannelAdapter: Send + Sync {
    fn platform(&self) -> &'static str;
    async fn render(&self, target: &ChatTarget, out: &Outbound) -> Result<(), ChannelError>;
}
```

WeCom 的流式帧节流、KOOK 的卡片、邮件的 MIME 与引用剥离、各家的分片长度，全部留在这里——它们换个平台就不成立，符合判据。

## 每个文件的去向

| 文件 | 行数 | 去向 | 理由 |
|---|---|---|---|
| `wecom.rs` `feishu.rs` `kook.rs` `seatalk.rs` `wechat.rs` `discord.rs` `email.rs` | ~11,350 | **留下但瘦身**：只保留协议 I/O 与渲染 | 判据：协议部分换平台不成立 |
| `session.rs` | 417 | **删除**，映射归一到云端 session + daemon 侧解析 | 第三套真相来源；`model` 偏好属运行时 |
| `session_queue.rs` | 386 | **移入 B 层** | 每会话串行/超时/回收是 turn 语义，与平台无关 |
| `pending_question.rs` | 664 | **移入 B 层** | `/answer` 是会话能力，四个渠道各接一遍 |
| `commands.rs` | 1,393 | **拆**：命令表与文案留 A（面向聊天），语义实现移 B | 表是展示，语义是会话 |
| `i18n.rs` | 529 | **留下** | 聊天回执文案；#934 已把 locale 收成设备级 |
| `email_db.rs` | 507 | **留下** | 邮件线程/Message-ID 是邮件协议自己的状态 |
| `workspace_instructions.rs` | 164 | **移出**到 `teamclu-runtime-env` | 与 desktop 共用；写 `CLAUDE.md` 不是网关该有的权力 |
| `channel_store.rs` `agent.rs` | 379 | **替换**为 `ConversationPort` + `ChannelAdapter` | 病根 |
| `binding.rs` `config.rs` `*_config.rs` | ~900 | 留下 | 绑定 URI 与各家凭据 |

`lib.rs` 里 desktop 直接用的 `read_config` / `patch_config_value` / `sync_teamclu_claude_md` / `wecom::send_proactive_message` 需要一并安置：前三个随 `workspace_instructions` 去 `teamclu-runtime-env`，最后一个走 `ChannelAdapter::render`。

## 迁移顺序

每一阶段独立可发、独立可回滚。

**P0 — 止血（已完成，#934）**
立刻落库、双向广播、出站附件入库。`GatewayLiveNotifier` 与 `MessageDedup` 就是 B 层的雏形。

**P1 — 会话映射归一**
删 `session.rs`；desktop 的 cron scheduler 与 email 线程跟踪改读统一来源。风险最低、收益立刻可见（少一处不一致）。

**P2 — 写入与附件收成一个 service**
把 #934 的 `GatewayLiveNotifier` 长成完整的写入服务：insert / broadcast / claim / 附件入库（双向共用一套路径与阈值）。cron 迁过来，删掉它自己那份 metadata 拼装与本地 TOML 旁路。

**P2.5 — 网关停止劫流（本设计的核心一步）**
`run_turn` 不再 `checkout_turn_for_acp`；改为 deliver + subscribe。事件泵在网关会话上恢复运行，
`emit_agent_message` 接管全部写入与广播，网关侧的 `record_agent_reply` 随之删除。
**前置**：per-agent 的 turn 串行今天正是由 `checkout_turn_for_acp` + `turn_lock` 提供的，所以
必须与 P4（排队上移）一起设计——先把排队搬进 B 层，再撤掉 checkout，否则会出现并发 turn。

**P3 — 命令语义收口**
`AgentHandle` 拆成"运行时 port"（send/cancel/stream）与"会话管理"（sessions/workspace/model/participants）。渠道不再直接持有后者；`/workspace` 不再由渠道写 `daemon.toml`。

**P4 — turn 排队上移**
`session_queue` 移入 B，7 个渠道删掉各自的接线。

**P5 — 渠道只剩协议**
按上表瘦身，`ConversationPort` 正式取代 `ChannelStore` + `AgentHandle`。此时新增一个平台的成本 = 一个 `ChannelAdapter`。

## 测试

- **双端一致性回归**（P0 起每阶段都跑）：桌面端与 WeCom 同时打开同一 session，验证消息、流式、附件三者实时一致。这是 #933 三个症状的验收面。
- 单测跟着语义走：语义搬到哪一层，测试就搬到哪一层——P4 之后不该再有渠道文件测排队超时。
- 契约测试：`ConversationPort` 的 mock 实现 + 每个 `ChannelAdapter` 的渲染测试，替代今天"起一个真网关"的重测试。
- 每阶段必跑：`cargo test -p amuxd --locked`、`cargo test -p teamclu-gateway`、`cargo test -p teamclu-runtime-env --locked`（#934 的 CI 红灯出在第三条，本地容易漏）。

## 非目标 / YAGNI

- **不动桌面端写入路径**。它已经是目标形态。
- **不追求"渠道文件变短"**。协议代码该多长就多长。
- **不做新能力**（引用、编辑、撤回、已读）。本设计只让它们将来只需要写一遍。
- **不改 crate 依赖方向**。接口留在 gateway crate。
- **不合并 `email_db`**。邮件线程是协议状态，不是会话状态。

## 开放问题

1. **`pending_question` 的归属**：移到 B 层后，桌面端要不要也能回答 agent 的澄清提问？如果要，它就不只是"网关能力"，接口形状需要再想。
2. **流式的回压**：`ReplySink` 目前设想是"推最新累计文本"，WeCom 靠同 id 覆盖气泡。KOOK/Discord 是编辑消息、邮件根本没有流式——`ReplyFrame` 要不要带"该平台是否支持中途更新"的能力位。
3. **`AgentHandle` 上的 `list_workspaces` / `set_workspace`**：P3 之后由谁暴露给聊天用户？如果保留 `/workspace`，权限边界要明确（现在任何能给机器人发消息的人都能改它的默认工作区）。
4. **cron 的本地 TOML**：`persist_message` 是否还有存在必要，还是纯历史包袱。
5. **撤掉 checkout 后的串行保证**：今天"一个 agent 同时只跑一轮"是 `checkout_turn_for_acp`
   （`event_rx` 只有一份）天然给的。P2.5 撤掉它之后，这个不变量必须由 B 层的排队显式维持，
   否则两条渠道消息会并发进同一个 runtime。这是 P2.5 与 P4 必须同批的原因。
6. **mid-turn flush 映射成几个气泡**：aggregator 在工具调用处 flush（这些只上 live、不落库，见
   `TurnAggregator::cloud_persistent`）。WeCom 今天是一个气泡不断长大。继续"一轮一个气泡"更干净，
   但长回复会有很长时间只见一个滚动气泡；按工具边界断成多条则更像"进度"。未定。
7. **`Lagged` 的兜底**：终帧若被 broadcast 丢掉，气泡永远收不了口。倾向于终帧不走 broadcast，而是
   turn 结束时由服务直接调 `render`（那时它已有落库后的权威文本）。
8. **`outbound` 与 `render` 的边界**：MCP send 走 `outbound`（先入库再渲染），服务自己的 turn 产出
   直接 `render`。两条最终都落到同一个 `render`，但入库时机不同——必须写死，否则会再长出第二套。

# 网关架构重做：渠道退回传输驱动

- **Date**: 2026-08-18
- **Status**: Design proposal — 待评审，未实现
- **Scope**: `crates/teamclu-gateway`（17.3k 行，8 个渠道），以 **WeCom / 飞书 / 邮件** 三个渠道为设计基准
- **Related**: #933（网关收拢为传输适配器）。#933 是"把 session 写入收成一套"，本文是"把渠道本身收成一套"，两者共用同一层写入服务

---

## 1. 现状：每个渠道都是一份从零开始的实现

`crates/teamclu-gateway` 目前共享的只有两个 trait（`AgentHandle`、`ChannelStore`）、命令解析（`commands.rs`，#934 刚收拢）、一个本地 session JSON 映射（`session.rs`）、排队器（`session_queue.rs`）和 i18n。**其余每个渠道各写一遍**：连接与重连、去重、白名单过滤、@ 规则、流式节流、附件、渲染、错误回复。

后果不是"代码重复"这么温和 —— 是**功能能力按渠道随机分布**。实测三个渠道：

| 能力 | WeCom (3009 行) | 飞书 (1597 行) | 邮件 (2360 行) |
|---|---|---|---|
| 入站附件 | ✅ 下载解密 + 上传 + 入库 | ❌ 显式忽略图片（`feishu.rs:1016` "text-only agent path"） | ❌ 零处理（全文件 0 处 attachment） |
| 出站附件 | ✅ `upload_and_send_media` | ❌ | ❌ |
| 流式回复 | ✅ `send_prompt_streamed` + 卡片更新节流 | ❌ 阻塞 `send_prompt` | ❌ 阻塞 |
| 去重 | 内存 `mark_message_processed` | 无（依赖平台不重投） | UID 水位 + `email_db.rs`（507 行） |
| 交互式提问 | ✅ 模板卡片 | ❌ | ❌ |
| 会话映射 | binding → acp → cloud session | 同左 + `session.rs` 里的 `feishu:<chat_id>` | 同左 + `email:thread:<msg_id>` 索引 |

也就是说：**新接一个渠道 = 从零开始，且大概率停在"能收发文本"这一档**。飞书和邮件就停在这一档。用户在企微能发图片、能看流式、能被追问，换到飞书同一个 session 就全没了 —— 但那是同一个 session。

还有一个隐蔽问题：session 身份有**两套**。`ChannelStore::ensure_session` 给的是云端 session id，而 `session.rs` 里另有一份按 `"feishu:<chat_id>"` / `"email:thread:<id>"` 为键的本地 JSON 映射（存 opencode session id 和模型偏好）。两套都在用，谁是权威没有定义。

---

## 2. 目标

**渠道只做传输，能力属于内核。**

- 接一个新渠道 = 实现一个窄 trait（解析、发送、可选的媒体上传），**自动获得**附件、流式、去重、命令、i18n、排队、交互提问
- 一个渠道不支持某能力时，内核**降级**而不是消失（邮件不能流式 → 内核缓冲后一次发出，而不是"邮件没有流式"）
- 一个 session 在任何渠道看到的语义一致 —— 这条与 #933 是同一个目标，本文是它的渠道侧

**非目标**：不改渠道的协议细节（企微加密、飞书 token 刷新、IMAP IDLE 这些留在驱动里）；不动 `commands.rs` 刚收拢的命令层。

---

## 3. 核心抽象

### 3.1 入站：渠道把原生事件归一化

```rust
pub struct InboundMessage {
    pub channel: ChannelId,             // "wecom" / "feishu" / "email"
    pub bot_id: Option<String>,         // 一个渠道可跑多个 bot（企微已经如此）
    pub conversation: Conversation,     // 见 3.3
    pub sender: ExternalSender,         // 渠道用户 id + 显示名 + 可选邮箱
    pub external_message_id: String,    // 去重键，渠道内唯一
    pub text: String,
    pub attachments: Vec<InboundAttachment>,  // 惰性：拿到的是 fetch 闭包，不是字节
    pub addressed_to_bot: bool,         // 群里是否 @ 了 bot；邮件恒为 true
    pub reply_to: Option<String>,       // 渠道原生的"回复某条"
    pub received_at: DateTime<Utc>,
}
```

驱动负责把签名校验、解密、token 刷新、MIME 解析、IMAP fetch 全部消化掉，**内核只见 `InboundMessage`**。

### 3.2 出站：内核给意图，驱动决定怎么渲染

```rust
pub struct OutboundMessage {
    pub text: String,
    pub attachments: Vec<SessionAttachment>,   // 已经入库的 session 附件
    pub question: Option<InteractiveQuestion>, // 需要用户选择时
}

pub struct ChannelCaps {
    pub streaming_edit: bool,   // 能否边生成边改同一条消息
    pub media_upload: bool,
    pub interactive: bool,      // 卡片/按钮
    pub threading: Threading,   // Inline | ReplyTo | MailThread
    pub max_chars: usize,
}
```

内核按 caps 降级：`streaming_edit=false` → 整轮缓冲后一次发出；`media_upload=false` → 附件转成可下载链接附在文末；`interactive=false` → 交互提问退化成"回复数字选择"。**降级规则写一次，所有渠道共享**。

### 3.3 会话模型：三个渠道差异最大的地方

这一层不能假设，必须逐个渠道定义 `Conversation`：

| | WeCom | 飞书 | 邮件 |
|---|---|---|---|
| 会话单元 | (bot, chat\|user) | chat_id | **线程**（`Message-ID` / `In-Reply-To` / `References` 链） |
| 谁能开新会话 | @bot 或私聊 | @bot 或私聊 | 任何发到该地址的邮件 |
| 身份可信度 | 平台鉴权，可信 | 平台鉴权，可信 | **From 可伪造** → 必须白名单 + 可选 DKIM/SPF 校验 |
| 一轮的边界 | 一条消息 | 一条消息 | 一封邮件（可能包含引用历史，需剥离） |
| 回复归位 | 直接发到 chat | reply API | **必须带 `In-Reply-To`**，否则线程断开、下一封归不到同一 session |
| 时延容忍 | 秒级 | 秒级 | 分钟级（IDLE 25 分钟续期 / 30 秒轮询） |

**邮件是压力测试用例**：它没有流式、没有 @、身份不可信、时延以分钟计、附件是 MIME 部件。任何"内核假设渠道像 IM"的设计都会在邮件上崩。反过来，能容纳邮件的抽象，接微信/短信/工单系统时不用再改。

### 3.4 渠道驱动 trait

```rust
#[async_trait]
pub trait ChannelDriver: Send + Sync {
    fn id(&self) -> ChannelId;
    fn caps(&self) -> ChannelCaps;

    /// 连接并把归一化后的入站消息推进 sink；断线重连自理。
    async fn run(&self, sink: InboundSink, shutdown: ShutdownSignal) -> Result<(), DriverError>;

    /// 渲染一条出站消息。流式由内核按 caps 决定是否多次调用同一 handle。
    async fn deliver(&self, to: &Conversation, msg: &OutboundMessage) -> Result<DeliveryId, DriverError>;

    /// 仅 streaming_edit=true 的渠道实现。
    async fn update(&self, id: &DeliveryId, text: &str, finished: bool) -> Result<(), DriverError> { ... }
}
```

---

## 4. 内核流水线（唯一实现）

```
驱动 → InboundMessage
        │
        ├─ 去重       (channel, external_message_id) —— 一个存储，替换掉三套各自的做法
        ├─ 路由       conversation → binding → session（退休 session.rs 那份本地 JSON 映射）
        ├─ 身份       external user → external actor + 加入 participant
        ├─ 准入       白名单 / 群 @ 规则 / 命令识别（commands.rs）
        ├─ 写入       ★ session 写入服务（#933）：入库 + 广播 + 附件，双向同一条路径
        ├─ 驱动 turn  走正常 session runtime 生命周期，而不是另起一条
        └─ 回送       OutboundMessage → 按 caps 降级 → driver.deliver / update
```

★ 这一层就是 #933 要抽的写入服务。**两件事必须一起做**：只做 #933，渠道仍各自解析各自渲染；只做本文，写入仍是两套。

---

## 5. 迁移顺序

1. **WeCom 先行** —— 它是唯一功能完整的渠道，把它拆成"驱动 + 内核"能证明抽象容得下最富的那个（媒体、流式卡片、交互提问、多 bot）。拆完 WeCom 的行为必须逐项不变，这是验收线。
2. **飞书第二** —— 证明"能力少的渠道自动获得能力"：接上内核后，入站附件和流式**不需要在飞书代码里写**就应该可用（飞书本身有文件下载 API 和消息更新 API，只是现在没接）。
3. **邮件第三** —— 证明非 IM 形态能被容纳：线程模型、不可信身份、无流式、分钟级时延。
4. 其余渠道（KOOK / SeaTalk / 微信 / Discord）按同样方式收编，每个应该只剩几百行驱动。

每步都能单独上线，中途不存在"两套并存但都不完整"的状态。

## 6. 迁移完成后可以删除

- 各渠道的去重实现（`mark_message_processed`、UID 集合、`email_db.rs` 的去重部分）
- `session.rs` 的本地 session 映射（云端 session 成为唯一权威）
- 各渠道的 turn 驱动与流式节流散落实现
- `ChannelManager::dispatch_send` 的旁路文件语义（#933 第 3 条）

---

## 7. 风险与未决问题

1. **排队器的超时对邮件不成立**：`session_queue.rs` 的 `MESSAGE_TIMEOUT = 180s`、`IDLE_TIMEOUT = 300s` 是按 IM 定的，邮件一轮可能超过。超时应随 caps 走，而不是全局常量。
2. **邮件身份**：`From` 可伪造，白名单是必要但不充分。是否要求 DKIM/SPF 通过才建 session？拒绝时是否回信（回信会给伪造者反馈）？需要产品决定。
3. **流式节流属于驱动**：企微卡片更新有频率限制，飞书消息更新也有。内核只管"文本又长了"，节流规则留在驱动里，否则内核会长出渠道细节。
4. **多 bot**：企业微信已经一个渠道多 bot，`bot_id` 必须进 `Conversation` 的键，否则两个 bot 的同名群会撞。
5. **附件惰性获取**：入站附件用闭包而非字节，是为了让"纯文本消息立即开始 turn"（WeCom 现在的行为）不被附件下载拖慢；但闭包的生命周期要跨过 turn，需要明确谁持有。
6. **兼容期**：`session.rs` 的本地映射退休时，已有的 `feishu:<chat_id>` / `email:thread:<id>` 记录需要迁移到云端 session 绑定，否则老会话会断。

---

## 8. 与 #933 的分工

| | #933 | 本文 |
|---|---|---|
| 收敛什么 | session **写入**（入库 / 广播 / 附件 / turn 生命周期） | **渠道**（解析 / 路由 / 去重 / 渲染 / 能力降级） |
| 谁调谁 | 被网关和 cron 调用 | 调用 #933 的写入服务 |
| 单独做的后果 | 渠道仍各写各的 | 写入仍是两套 |

建议合并成一个方向推进：先落 #933 的写入服务接口，随即用 WeCom 拆分验证本文的驱动抽象 —— WeCom 拆分本身就是写入服务的第一个真实调用方。

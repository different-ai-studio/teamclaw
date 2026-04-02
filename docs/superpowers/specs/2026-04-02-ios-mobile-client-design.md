# TeamClaw iOS Mobile Client Design Spec

**Date:** 2026-04-02
**Branch:** feature/mobile-client
**Status:** Draft

---

## 1. Overview

### 1.1 Product Positioning

TeamClaw iOS 客户端是桌面端的**移动远程前端**，核心场景是移动办公时与 Agent 对话、管理自动化任务和浏览技能。

**核心原则：**
- **桌面端是大脑** — Agent 执行、文件操作、知识库等全部在桌面端运行
- **中继 Broker 是邮局** — 转发消息、缓存离线消息、触发推送通知
- **iOS 端是对讲机** — 展示对话、发送指令、接收通知

### 1.2 V1 Scope

**包含：**
- 与 Agent 对话（流式 Markdown 渲染）
- 自动化任务管理（增删改）
- 技能浏览（个人技能 + 团队技能）
- 桌面端连接状态
- 协作 Session（邀请团队成员进入对话）
- 设置（配对、模型切换、通知偏好）

**明确不做：**
- 文件编辑 / Diff 查看
- 知识库管理
- Agent / MCP 配置
- 团队管理（继承桌面端上下文）
- 语音输入

---

## 2. Architecture

### 2.1 System Architecture

```
┌─────────────┐                                    ┌──────────────┐
│  iOS App    │◄──MQTT──►┌──────────────┐◄──MQTT──►│  桌面端 Tauri │
│  (SwiftUI)  │          │ MQTT Broker  │          │  (现有)       │
└─────────────┘          │ (EMQX)       │          └──────────────┘
                         └──────┬───────┘
                                │ webhook/bridge
                                ▼
                         ┌──────────────┐
                         │  APNs 推送    │
                         └──────────────┘

图片附件:
iOS App ──上传──► 阿里云 OSS ◄──下载── 桌面端
         MQTT 只传 OSS 路径
```

### 2.2 Communication Protocol: MQTT

**选择 MQTT 而非 WebSocket 的原因：**
- 原生离线消息支持（QoS 1/2 + retained message）
- 专为低带宽/不稳定移动网络设计
- 原生发布/订阅模型，适合多设备同步
- 成熟 Broker 生态（EMQX）开箱即用消息队列和 APNs 桥接

**MQTT Broker:** EMQX（国产，企业级，免费版可用，原生支持 APNs/FCM 推送桥接）

### 2.3 MQTT Topic Design

```
teamclaw/{team_id}/{device_id}/chat/req      # 手机→桌面：发起对话/指令
teamclaw/{team_id}/{device_id}/chat/res      # 桌面→手机：Agent 响应（流式）
teamclaw/{team_id}/{device_id}/status        # 桌面端在线状态（retained message）
teamclaw/{team_id}/{device_id}/task          # 任务状态更新
teamclaw/{team_id}/{device_id}/skill         # 技能列表同步
teamclaw/{team_id}/{device_id}/member        # 团队成员数据同步
```

> **注：** `{team_id}` 由桌面端提供，手机端不管理团队，仅用作消息路由的命名空间。

**QoS 策略：**
- **QoS 1**（至少投递一次）：聊天消息、通知、任务更新
- **QoS 0**（最多一次）：状态心跳
- **Retained Message**：桌面端在线状态 — 手机端连接后立即获知桌面端是否在线
- **Clean Session = false**：手机端断线重连后自动收到离线期间的消息

**消息格式（JSON）：**

```json
{
  "id": "uuid",
  "type": "chat_request | chat_response | status | task_update | skill_sync | member_sync",
  "timestamp": 1712000000,
  "payload": { ... }
}
```

### 2.4 Streaming Response Handling

Agent 响应是逐 token 流式输出的。采用**缓冲聚合**方案：

- 桌面端每 **200-300ms** 将累积的 token 聚合成一条 MQTT 消息发出
- 每条消息带 `seq` 序号，手机端按序拼接
- 最后一条 `done:true` 附带完整内容，用于校验/补全

```json
{"id":"msg1", "seq":0, "delta":"你好，我来帮你", "done":false}
{"id":"msg1", "seq":1, "delta":"看看这个问题。\n根据...", "done":false}
{"id":"msg1", "seq":2, "delta":"分析结果如下", "done":true, "full":"完整内容..."}
```

**优势：** 消息量降 10 倍+，弱网体验好，手机端仍有"打字机"效果，200ms 延迟用户几乎无感。

### 2.5 Image Attachment Flow

- iOS 端选择图片后上传至**阿里云 OSS**
- MQTT 消息中只传 OSS 路径
- 桌面端从 OSS 下载图片后交给 Agent 处理

---

## 3. Desktop Side Changes

### 3.1 New Module: `mobile_relay.rs`

在桌面端 `src-tauri/src/commands/` 下新增 `mobile_relay.rs` 模块。

```
桌面端内部
┌─────────────────────────────────┐
│  现有 Agent/Gateway 逻辑        │
│         │                       │
│         ▼                       │
│  mobile_relay 模块              │
│  ├── MQTT Client (rumqttc)      │
│  ├── 消息聚合器 (200ms buffer)   │
│  ├── 设备配对管理                │
│  └── 状态发布 (retained)         │
│         │                       │
│         ▼                       │
│  MQTT Broker (EMQX)            │
└─────────────────────────────────┘
```

**职责：**
1. **Agent 响应转发** — 拦截 Agent 流式输出，聚合后发到 MQTT
2. **手机指令接收** — 订阅手机端的 `chat/req` topic，转发给本地 Agent 执行
3. **状态发布** — 定期发布 retained message 标识在线状态
4. **设备配对** — 管理手机设备的认证与绑定
5. **协作 Session 路由** — 多设备消息分发

### 3.2 Device Pairing

```
桌面端设置页 → 生成 6 位配对码(有效期 5 分钟) → 手机端输入配对码 → 双方交换设备 ID → 完成绑定
```

配对完成后，桌面端为该手机设备生成 MQTT 认证凭据（username/password），用于后续连接 Broker 的身份验证。

---

## 4. iOS App Design

### 4.1 Tech Stack

| 层面 | 选型 |
|------|------|
| UI | SwiftUI (iOS 16+) |
| 架构 | MVVM + Combine |
| MQTT | CocoaMQTT 或 MQTTNIO |
| Markdown 渲染 | swift-markdown + AttributedString |
| 推送 | APNs (通过 EMQX webhook) |
| 本地存储 | SwiftData（缓存对话历史） |
| 图片上传 | Alamofire / URLSession → 阿里云 OSS |

### 4.2 Module Structure

```
TeamClawMobile/
├── Core/
│   ├── MQTTService          # MQTT 连接、重连、订阅管理
│   ├── MessageAggregator    # 流式消息组装（seq 排序 + 拼接）
│   ├── PairingManager       # 设备配对流程
│   ├── ConnectionMonitor    # 桌面端在线状态监听
│   └── OSSUploader          # 阿里云 OSS 图片上传
├── Features/
│   ├── SessionList/
│   │   ├── SessionListView       # 首页 Session 列表
│   │   └── SessionListViewModel
│   ├── Chat/
│   │   ├── ChatDetailView        # 对话详情（流式渲染）
│   │   └── ChatDetailViewModel
│   ├── TeamMembers/
│   │   ├── MemberListView        # 团队成员列表（右滑）
│   │   ├── MemberSessionsView    # 与某成员相关的协作 Session
│   │   └── MemberViewModel
│   ├── Automation/
│   │   ├── TaskListView          # 自动化任务列表（增删改）
│   │   └── TaskViewModel
│   ├── Skills/
│   │   ├── SkillHomeView         # 技能主页（个人 + 团队）
│   │   └── SkillViewModel
│   └── Settings/
│       ├── PairingView           # 设备配对
│       ├── NotificationPrefView  # 通知偏好
│       └── SettingsView          # 主设置页
├── Shared/
│   ├── MarkdownRenderer          # Markdown → SwiftUI 渲染
│   ├── DesktopStatusBadge        # 在线/离线状态组件
│   └── Models/                   # 共享数据模型
└── Resources/
```

### 4.3 Offline Strategy

- SwiftData 缓存最近 100 条对话和任务状态
- 桌面端离线时：可浏览历史，输入框禁用并提示"桌面端离线"
- 重连后：MQTT `clean session=false` 自动补发离线消息

---

## 5. UI Design

### 5.0 Visual Style: Light & Conversational

**风格定位：** 轻盈对话风 — 类似 iMessage/Telegram，亲和力强，强调"搭档"的陪伴感。

**色彩：**
- 主背景：纯白 (#FFFFFF) / 浅灰 (#F5F5F7)
- AI 消息背景：极浅蓝灰 (#F0F1F5)，无边框，直接铺底
- 用户消息气泡：品牌主色（建议柔和蓝 #007AFF 或与桌面端品牌色一致），白色文字
- 协作成员消息气泡：浅绿 (#E8F5E9)，与 AI 和用户消息区分
- 强调色/交互色：与品牌主色一致

**排版：**
- 字体：SF Pro（iOS 系统字体），消息正文 16pt，辅助文字 13pt
- 圆角：消息气泡 16px，卡片 12px，按钮 8px
- 间距宽松，留白充足，阅读舒适

**元素风格：**
- 用户消息：右侧圆角气泡，带品牌色背景
- AI 消息：无气泡，浅底色平铺全宽，视觉上像"内容区"而非"对话气泡"
- 列表项：简洁卡片式，头像圆形，hover/press 有轻微灰底反馈
- 浮动按钮（FAB）：品牌主色，圆形，轻微阴影
- 侧边栏：半透明毛玻璃效果（iOS 原生 .ultraThinMaterial）

**动效：**
- 页面转场：iOS 原生 push/pop 动画
- 侧边栏滑出：弹性阻尼，跟手滑动
- 消息出现：轻微 fade-in + 上移，不过度花哨
- 流式打字：逐段出现，光标闪烁

**暗色模式：** V1 不做，后续可通过 SwiftUI 的 `@Environment(\.colorScheme)` 扩展。

### 5.1 Page Structure Overview

```
◄── 右滑：团队成员          首页：Session List           左滑：功能面板 ──►

┌──────────────────┐    ┌──────────────────┐    ┌──────────────────┐
│                  │    │  🔍 搜索栏        │    │                  │
│  👤 张三 (运营)   │    │                  │    │  ┌──────┐┌──────┐│
│  👤 李四 (开发)   │    │  🤖 运营搭档      │    │  │⚡自动化││🧩技能 ││
│  👤 王五 (设计)   │    │  帮你整理了日报... │    │  └──────┘└──────┘│
│  ...             │    │            2分钟前 │    │                  │
│                  │    │                  │    │                  │
│  点击成员:        │    │  🤖 代码搭档 👤👤 │    │                  │
│  1.查看协作Session│    │  张三: 方案可以... │    │                  │
│  2.新建协作Session│    │            1小时前 │    │                  │
│                  │    │                  │    │                  │
│                  │    │  🤖 客服搭档      │    │  ┌────────────┐  │
│                  │    │  已回复3条客户消息  │    │  │👤 个人头像   │  │
│                  │    │            3小时前 │    │  │  ⚙️ 设置    │  │
│                  │    │           [＋] 🔵│    │                  │
└──────────────────┘    └──────────────────┘    └──────────────────┘
```

### 5.2 Session List (Home Page)

- 顶部搜索栏：搜索 Session 标题和内容
- 列表项显示：Agent 头像、Session 标题、最后一条消息内容、时间
- 协作 Session 额外显示参与成员头像和最后发言人
- 右下角浮动「+」按钮：新建 Session

### 5.3 Session Detail (Chat Page)

```
┌──────────────────────────────┐
│  ← 返回    运营搭档    👤👤   │  ← 标题栏 + 协作成员头像(如有)
├──────────────────────────────┤
│                              │
│  ┌──────────────────────────┐│
│  │ AI: 我帮你分析了昨天的    ││
│  │ 运营数据，主要发现：       ││
│  │                          ││
│  │ **1. 用户增长**           ││  ← AI 回复：100% 宽度
│  │ - DAU 环比上升 12%        ││     完整 Markdown 渲染
│  │ - 新注册用户 340 人       ││
│  │                          ││
│  │ ```                      ││
│  │ 付费转化: 3.2% → 4.1%    ││
│  │ ```                      ││
│  └──────────────────────────┘│
│                              │
│          ┌──────────────┐    │
│          │ 帮我做一份    │    │  ← 用户消息：靠右，~70% 宽度
│          │ 周报摘要      │    │
│          └──────────────┘    │
│                              │
│  ┌──────────────────────────┐│
│  │ AI: 好的，正在生成... █   ││  ← 流式输出中
│  └──────────────────────────┘│
│                              │
├──────────────────────────────┤
│  ⚙️  📎                      │  ← 工具栏
│  ┌────────────────────┐      │     ⚙️ 切换模型
│  │ 输入消息...          │  ➤  │     📎 添加图片(上传OSS)
│  └────────────────────┘      │
└──────────────────────────────┘
```

**消息样式：**
- **AI 回复：** 靠左，占满横向宽度，完整 Markdown 渲染（标题、列表、代码块、表格）
- **用户消息：** 靠右，约 70% 宽度
- **协作成员消息：** 靠左，与 AI 消息视觉区分（不同头像/背景色）
- **桌面端离线时：** 输入框禁用，显示"桌面端离线"

**工具栏按钮：**
- **⚙️ 设置：** 弹出模型选择器（模型列表从桌面端同步）
- **📎 附件：** 打开图片选择（相册/拍照），图片上传至阿里云 OSS，MQTT 只传路径

### 5.4 Team Members Panel (Right Swipe)

- 成员列表：头像、姓名、备注
- 数据从桌面端同步
- 点击成员后显示：
  1. 与该成员相关的协作 Session 列表
  2. 「新建协作 Session」入口 — 创建新 Session 并拉该成员进来

### 5.5 Function Panel (Left Swipe)

**上方入口：**
- **⚡ 自动化** → 任务列表页（支持添加、删除、修改任务）
- **🧩 技能** → 技能主页（个人技能 + 团队技能展示）

**下方：**
- 个人头像 + 设置页面入口

### 5.6 Automation Page

- 自动化任务列表
- 每个任务显示：名称、状态（运行中/已完成/失败）、上次执行时间
- 支持：新建任务、编辑任务、删除任务

### 5.7 Skills Page

- 分两个区域：我的技能、团队技能
- 每个技能显示：名称、描述、状态

---

## 6. Collaborative Sessions

### 6.1 Concept

多个团队成员可以在同一个 Agent Session 里协作对话。一个 Session 的 owner 可以邀请其他成员加入。

### 6.2 Entry Points

1. **团队成员面板**（右滑）→ 点击成员 → 查看/新建协作 Session
2. **Session Detail** 内（未来可扩展邀请入口）

### 6.3 Display

- 首页 Session List 中协作 Session 显示参与者头像
- Session Detail 中顶栏显示协作成员头像
- 协作成员的消息与 AI 消息、用户自己的消息在视觉上区分

---

## 7. Security

### 7.1 Device Pairing

```
桌面端设置页 → 生成 6 位配对码(有效期 5 分钟) → 手机端输入 → 双方交换设备 ID + MQTT 凭据 → 完成绑定
```

- 配对码有效期 5 分钟，过期需重新生成
- 一个桌面端可绑定多台手机设备
- 桌面端可在设置中解绑已配对设备

### 7.2 Data in Transit

- MQTT 通信走 TLS (MQTTS, port 8883)
- 图片通过 HTTPS 上传/下载 OSS

# 会话切换性能 + 聊天体验需求说明

> **状态：** 需求归档（原 PR #832 放弃，由新 agent 在最新 `main` 上重新实现）  
> **范围：** Web / Desktop 聊天面板（`packages/app/`）  
> **背景：** 长会话、多 tool call 的历史消息在切换会话时卡顿；另有 reply-to 跳转时 header 错位。

本文只描述**要解决的问题、预期行为与验收标准**，不包含具体代码方案或实现细节。

---

## 1. 问题背景

### 1.1 会话切换卡顿

切换到一个消息较多的会话时，用户能感知明显延迟。调查结论（现象层，非实现约束）：

- 每次切换都会对整段 proto 消息做完整的 v2 → SDK 适配（CPU 密集），且稳态下同一套数据可能被适配两次。
- 会话 fade 动画期间，旧会话与新会话的消息列表可能并行走两套适配路径。
- 已完成的历史 agent turn 若包含大量 tool call / thinking，会在列表 mount 时一次性渲染全部 Process 卡片，加重切换成本。

### 1.2 Reply-to 跳转 header 错位

点击 reply-to 引用跳转到目标消息时，若使用页面级滚动，sticky 聊天 header 与目标消息的对齐会出错（目标被 header 遮住或位置偏移）。

---

## 2. 需求 A — 稳态会话切换：避免重复适配

### 目标

当用户已在查看的会话与 store 中的 active 会话一致时（无 fade 过渡），消息列表不应再做第二次全量 v2 适配。

### 预期行为

| 场景 | 预期 |
|------|------|
| 稳态：展示中的 sessionId === activeSessionId | 消息列表复用已适配好的 SDK 消息，不重复跑适配器 |
| Fade 过渡：展示中的 sessionId 滞后于 activeSessionId | 允许旧会话与新会话各走一条适配路径（过渡是短暂的） |
| 同一会话内新消息到达 | 正常随 store 更新；稳态下仍只适配一次 |

### 非目标

- 不改变 fade 动画本身的时长或交互。
- 不在此需求内解决「切换时 App 层全量 reload 无缓存 skip」（若仍存在，可另开任务）。

### 验收

- [ ] 在长会话 A ↔ B 来回切换时，稳态阶段 DevTools Performance 中适配相关 CPU 峰值明显低于改前（或同等消息量下主观切换更跟手）。
- [ ] Fade 期间旧会话内容仍能正常淡出，新会话淡入后内容正确。
- [ ] 流式中的 active 会话消息仍实时更新，无 stale 或丢消息。

---

## 3. 需求 B — 历史 Process 懒加载（展开时才 hydrate）

### 目标

**已完成**的历史 agent turn，默认不在列表 mount 时渲染完整 thinking + tool call 过程；用户展开「处理过程」后再加载并展示。

### 适用范围

**应 defer（懒加载）：**

- Turn 已结束（有最终 reply 文本，或 tool 均已 completed，等价的「不会再变」判定）。
- 该 turn 的 process 部分（thinking、tool-call 等）与最终正文可以分离展示。

**不应 defer：**

- 正在流式输出或 turn 尚未完成的 message。
- 整个 bubble 只有 process、没有可单独展示的最终正文（tool-only turn 等）— 这类应继续完整渲染，避免空白气泡。
- Session 导出、需要完整 transcript 的路径 — 必须拿到 full process，不能走 UI 懒加载路径。

### 预期行为

| 场景 | 预期 |
|------|------|
| 历史已完成 turn，默认收起 | 列表只渲染最终正文 + process 摘要（如 tool 数量）；不 mount 完整 ToolCall 卡片 |
| 用户点击展开「处理过程」 | 显示 loading，hydrate 后展示完整 thinking / tool calls；同 message 再次展开应命中缓存 |
| 活跃 / 流式 turn | 与改前一致，process 实时可见，不 defer |
| Session 导出 | 导出结果包含完整 thinking + tools，与改前 export 语义一致 |

### 数据 / 契约层（概念）

适配后的 SDK message 需要能表达：

- 该条是否 defer 了 process（布尔或等价语义）。
- defer 状态下 process 的轻量摘要（如 tool 数量、是否有 thinking），供 collapsible 标题使用。
- 展开 hydrate 时定位原始 turn 所需的引用（session + turn + sender 等），hydrate 输入为 store 中的 proto 消息。

### 非目标

- 不改变 Process collapsible 的视觉设计规范（仍遵循 AGENTS.md Editorial Calm）。
- 不改变 streaming 架构（streaming 阶段仍只读 streamingContent，完成后读 message.parts）。

### 验收

- [ ] 含 20+ tool call 的历史会话：切换进入后首屏 mount 明显快于改前；默认收起时不渲染 tool 卡片 DOM。
- [ ] 展开某条历史 process：tool / thinking 内容与改前 full adapt 一致。
- [ ] 流式 turn：进行中仍能看到 process 更新；完成后行为符合上表。
- [ ] Session 导出 JSON：仍含完整 tool/thinking parts。
- [ ] 单元测试覆盖：defer 判定、forceFull 路径、hydrate 结果与 full adapt 一致。

---

## 4. 需求 C — Reply-to 跳转：仅在消息列表容器内滚动

### 目标

从 reply-to 引用跳转到目标消息时，滚动应限制在聊天消息列表容器内，不影响外层 layout，sticky header 保持正确对齐。

### 预期行为

| 场景 | 预期 |
|------|------|
| 点击 reply-to 引用 | 目标 message 滚动到消息列表可视区域内，不被 sticky header 遮挡 |
| 目标在虚拟列表未渲染窗口外 | 先扩展/定位虚拟列表可见窗口，再滚到目标 |
| 跳转后 | 可选：短暂高亮目标 message（若产品已有 flash 行为则保持） |

### 非目标

- 不改变 reply-to 引用的 UI 样式。
- 不使用 `scrollIntoView` 直接滚整个页面/外层容器（已知会导致 header 错位）。

### 验收

- [ ] 线程较长、header sticky 时：点击 reply-to，目标消息完整出现在 header 下方。
- [ ] 目标在列表很靠上/靠下/未初始渲染时均能正确跳转。
- [ ] 单元测试覆盖：容器内 scroll 计算、message 元素查找逻辑（不依赖真实 DOM layout）。

---

## 5. 测试与回归清单

实现完成后至少验证：

| 类别 | 检查项 |
|------|--------|
| 自动化 | `pnpm typecheck`；v2 适配器相关 vitest；reply-to scroll 相关 vitest |
| 手动 — 切换 | 长会话 A/B 快速切换；fade 过渡无闪屏、无错会话内容 |
| 手动 — process | 历史 turn 默认收起 → 展开 hydrate；流式 turn 不受影响 |
| 手动 — reply-to | 跨多屏高度跳转；header 不挡目标 |
| 手动 — 导出 | 含 tool 的会话导出后 parts 完整 |

---

## 6. 明确不在本需求内

- TeamClu 重命名 / DNS / CI canary 等基础设施改动（随 `main` 已有方案即可）。
- OSS e2e `skills` → `knowledge` 目录 mkdir 修正（若 `main` 仍有遗漏，单独小 PR）。
- 150ms fade 人为延迟的移除或缩短（可另开 perf 任务）。
- App 层 session 切换时的全量 reload 缓存策略（可另开任务）。
- 未读 badge、列表分页、participants 缓存失效等 AGENTS.md Out-of-scope 项。

---

## 7. 实现提示（非方案）

- 在最新 `main` 上开新分支；命名与 proto/API 以当前 **TeamClu** 为准（`teamclu_pb`、`adaptTeamcluMessages` 等）。
- 三个需求可拆成独立 commit/PR，但 B 与 A 都_touch_ v2 适配器与 ChatPanel，合并时注意冲突。
- 优先保证 **流式 active turn** 与 **export full path** 零回归，再优化历史 turn 路径。

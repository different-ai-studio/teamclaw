# pi Agent 后端：与 opencode 对等的集成设计

> 状态：已实装（2026-07-22 设计；2026-08 多会话 host 落地，见 #991）。
> `build config` 的 `localAgent` 参数（`"opencode"` | `"pi"`）选 `pi` 时
> daemon 使用 [pi coding agent](https://github.com/badlogic/pi-mono)
> （`@earendil-works`）作为本地运行时，能力对等于 opencode serve HTTP 集成。

## 1. 进程 / 会话模型

pi 子进程有两种模式（`pi_rpc/process.rs`）：

- **Host（默认）**：`node <cache>/pi/host/host.mjs` —— TeamClu 自带的
  **多会话 host**，随 amuxd 分发（`include_str!` 物化），进程内跑 N 个并发
  `AgentSession`（pi npm 包的 SDK 入口）。协议仍是 stdio JSONL，但每条命令
  和每条事件都带 `sessionId`，同 worktree 的多个会话并发 prompt / 流式 /
  cancel 互不影响。extension、MCP 桥、model registry 进程内共享——会话数
  增长不重复付 MCP 冷启动和基础内存。
- **LegacyRpc（回退）**：`pi --mode rpc`，单活动会话协议（命令/事件不带
  session 标识，`switch_session` 会销毁在跑的 turn，因此有 mid-turn 守卫，
  第二个会话发消息会被拒绝重试）。两种情况走这条路：pi 装的是 Bun 单二进制
  （解析不到可 import 的 npm 包根目录），或 `daemon.toml` 里
  `[agents.pi] session_host = "rpc"`（一键回退开关）。

进程池键 = **(isolation domain, process-env revision, canonical worktree)**
（对齐 opencode 的 host pool 维度；此前只按 worktree 分、env 池全局
first-wins，workspace A 的 env 会粘进 B 的进程）。会话文件仍只按 worktree
散列到 `<state>/pi-sessions/<hash>/`——resume 不受 env 变更影响。

| | opencode | pi（Host 模式） |
|---|---|---|
| 进程模型 | 全局 `opencode serve`（HTTP + SSE），域键池 | 每 (domain, env, worktree) 一个 `host.mjs` 进程（stdio JSONL） |
| 会话 | serve 内多会话，`?directory=` 定界 | host 内多 `AgentSession`，命令/事件带 `sessionId`；`--session-dir` 持久化（append-only JSONL） |
| 流式事件 | SSE：`message.part.delta` 等 | stdout 事件：`message_update`（text/thinking delta）、`tool_execution_start/update/end`、`agent_end`，全部带 `sessionId` |
| 权限审批 | 内建 `permission.asked` / reply 端点 | **无内建**——TeamClu pi extension 拦截工具执行，经 `extension_ui_request(confirm)` ↔ `extension_ui_response` 与宿主交互；host 模式下 uiContext 按会话闭包，请求天然归属正确会话 |
| question 工具 | 内建 | extension 注册 `question` 工具，经带 `teamclu.question=` 标记的 `select` dialog 走同一 UI 通道，amuxd 译成 `question_asked` |
| MCP | 内建（`opencode.json` 的 `mcp` 表） | **无内建**——extension 桥接（amuxd-remote-tools + workspace MCP），host 进程内共享一份 |
| 模型 | `/config/providers` 目录 | `get_available_models`（host 级）/ `set_model`（会话级）；自定义 provider 用 `registerProvider` |
| 取消 | per-session abort 端点 | `abort {sessionId}`，只中断该会话 |
| slash 命令 | 静态表（`builtin_commands.rs`） | 运行时 `get_commands` 真实列表，attach 时以 `AvailableCommands` 事件上报 |
| 断线补发 | SSE reconnect reconcile + replay | 子进程崩溃后按 route 记录的 leaf id `get_entries since` 回补未见尾部（`events::backfill_and_close`） |
| 安装分发 | 官方渠道 + `opencode.lock.json` | npm 包（`pi.lock.json` 最低版本锁 = host 依赖的 SDK 版本）；Bun 单二进制自动降级 LegacyRpc |

## 2. 架构：后端 trait 化

现状 `RuntimeManager` 依赖 `AcpHostPool`（`runtime/opencode_http/`）暴露的
接口面：`attach_session / AcpCommand{Prompt,Cancel,ResolvePermission,SetModel,
Shutdown} / AcpEventFrame / AcpStartupMetadata / prewarm / evict / host_count`。

新增抽象：

```rust
// apps/daemon/src/runtime/backend.rs
pub trait AgentBackend: Send {
    async fn attach_session(...) -> Result<(CmdTx, AcpStartupMetadata)>;
    async fn prewarm(...);
    fn evict(...);
    fn host_count(&self) -> usize;
}
// 实现者：OpencodeHttpBackend（现 opencode_http 改名包装）
//         PiRpcBackend（新增 runtime/pi_rpc/）
```

`RuntimeManager` 持 `Box<dyn AgentBackend>`，按 daemon 配置
`agents.local_agent`（默认 `opencode`）实例化。事件出口统一为
`amux.AcpEvent`——**gateway、MQTT、前端、iOS 全部零改动**。

## 3. `runtime/pi_rpc/` 模块设计（对等 opencode_http 四组件）

| 组件 | 职责 |
|---|---|
| `process.rs` | 进程池（键 = domain + env revision + worktree），Host/LegacyRpc 模式解析（npm 包根目录探测 + `[agents.pi] session_host` 配置），host.mjs / extension 物化，env 注入，kill_on_drop，崩溃后惰性重启。每 host 软上限 8 个常开会话，超出按 LRU close_session（route 保留，下次 prompt 重开） |
| `client.rs` | JSONL 命令写入 stdin（带 `id` 关联 response）：`open_session`/`new_session`/`close_session`、`prompt`（含 `streamingBehavior`）、`abort`、`set_model`、`get_available_models`、`get_state`、`get_entries since`、`get_commands`（Host 模式下命令带 `sessionId`） |
| `events.rs` | stdout 逐行解析（仅按 `\n` 切分），按事件 `sessionId` 路由（Legacy 回退到 active session）；未知 sessionId 丢弃不影响他会话；EOF 时结算该进程全部在跑 turn 并尝试 `get_entries since` 回补；`extension_ui_request` 的 confirm→权限、带标记的 select→question |
| `translate.rs` | `message_update.assistantMessageEvent`: `text_delta`→Output、`thinking_delta`→Thinking；`tool_execution_start`→ToolUse、`_end`→ToolResult（isError 映射）；`agent_end`→回合完成 StatusChange；`extension_error`→AcpError；`replay_entries`（崩溃回补去重重放）；question 标记解析 |

host 侧（`assets/pi-host/host.mjs`）只实现 daemon 真正用到的命令面，协议在
文件头注释里；契约测试在 `tests/pi_host.rs`（stub SDK：
`tests/fixtures/pi-host-stub/`，无网络无真 pi，验证并发、事件归属、
per-session abort、UI 归属）。

### 权限审批（关键差异点）

pi 无内建权限。方案：随 daemon 分发一个 **TeamClu pi extension**（TS 单文件，
安装到 `--extensions` 路径）：

1. extension 钩住全部工具执行（bash/edit/write 等）；
2. 按 TeamClu workspace 权限规则（daemon 通过 env/配置文件传入）决定放行或询问；
3. 需询问时调 `confirm` dialog → pi 发 `extension_ui_request{method:"confirm"}`
   到 stdout → `pi_rpc/events.rs` 翻译为 `AcpPermissionRequest`（request_id =
   ui request id）→ 走既有 UI 审批 → `ResolvePermission` → 写回
   `extension_ui_response{confirmed}`；
4. gateway 会话（is_gateway）由 daemon 直接自动应答 confirmed=true。

“始终允许”语义在 extension 内记忆（per session/workspace 规则文件）。

### MCP / remote-tools

同一个 TeamClu extension 内实现 MCP 客户端桥（pi 生态无内建 MCP）：
读取 daemon 注入的 MCP server 清单（沿用现在物化到 worktree 的配置文件，
或 env 指针），把 MCP tools 注册为 pi 工具。第一版可只桥
`amuxd-remote-tools`（gateway/团队功能依赖），通用 MCP 桥后续跟进。

### 模型 / LiteLLM

pi 配置文件（`~/.pi/agent/` 或 `--config`）里 `registerProvider` 指向
LiteLLM 网关（`openai-completions` API）。已知坑（调研已证实）：
需设 `compat.supportsDeveloperRole=false` 与 tool schema 清洗
（`onOpenAICompletionsCompat`），否则严格网关会拒绝请求。
`get_available_models` → `AcpStartupMetadata.available_models`。

## 4. `localAgent` 参数落点与数据流

1. **build config**（`build.config.*.json`）：顶层新增
   `"localAgent": "opencode" | "pi"`（缺省 `opencode`）。vite 注入
   `import.meta.env.VITE_LOCAL_AGENT` → `packages/app/src/lib/build-config.ts`
   暴露 `getLocalAgent()`。
2. **app → daemon**：桌面端 setup/onboarding 与 daemon 注册时，把
   `localAgent` 写入 daemon 配置（既有 daemon settings API），落到
   `~/.amuxd/config` 的 `agents.local_agent`。
3. **daemon**：启动时按 `agents.local_agent` 构造对应 backend；`doctor` /
   onboarding 检查相应二进制（opencode：现有逻辑；pi：`pi --version` 对照
   `pi.lock.json`，缺失/过旧给安装/升级动作，走 npm 或直下二进制）。
4. **UI**：设置页“运行时”只读行显示 opencode 或 pi；模型目录、权限卡片等
   全部走 `AcpEvent`，无感知。

## 5. 实施步骤

1. `AgentBackend` trait 抽取 + `opencode_http` 适配（无行为变化，回归即证）。
2. build config 参数 + app 透传 + daemon 配置位（本 PR 已含参数与透传骨架）。
3. `pi_rpc` 四组件 + JSONL 协议层 + 单测（用文档 JSON 样例喂 translate）。
4. TeamClu pi extension（权限门 + remote-tools MCP 桥）。
5. `pi_install`（对等 `opencode_install`：版本锁、doctor、安装/升级）。
6. tauri-mcp 桌面实测（对等本次 opencode 验收项）+ 文档。

## 6. 风险

- **pi 破坏性变更频繁**（两月 31 版、npm scope 迁移、v0.80 API 重构）：
  必须版本锁 + CI 里用锁定版本跑 translate 契约测试。
- **权限/MCP 全靠自带 extension**：extension API 本身也可能变；把 extension
  随 daemon 版本捆绑发布，不追 pi 上游 extension 生态。
- **单维护者上游**：issue 响应风格强硬，问题多半要自己修——必要时轻量 fork
  （只做 compat 修补，不像 opencode fork 那样背协议实现）。

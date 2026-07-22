# pi Agent 后端：与 opencode 对等的集成设计

> 状态：设计稿（2026-07-22）。目标：`build config` 新增 `localAgent`
> 参数（`"opencode"` | `"pi"`），选 `pi` 时 daemon 使用
> [pi coding agent](https://github.com/badlogic/pi-mono)（`@earendil-works`）
> 作为本地运行时，能力对等于现有 opencode serve HTTP 集成。

## 1. 两种运行时的形态差异

| | opencode（现状） | pi |
|---|---|---|
| 进程模型 | 全局单 `opencode serve`（HTTP + SSE） | **每 worktree 一个 `pi --mode rpc` 进程**（stdin/stdout JSONL） |
| 会话 | serve 内多会话，`?directory=` 定界 | 一进程一活动会话；`--session-dir` 持久化（append-only JSONL），`switch_session`/`get_entries since` 恢复 |
| 流式事件 | SSE：`message.part.delta` 等 | stdout 事件：`message_update`（text/thinking delta）、`tool_execution_start/update/end`、`turn_end`、`agent_settled` |
| 权限审批 | 内建 `permission.asked` / reply 端点 | **无内建**——须由 TeamClaw 自带的 pi extension 拦截工具执行，经 `extension_ui_request(confirm)` ↔ `extension_ui_response` 与宿主交互 |
| MCP | 内建（`opencode.json` 的 `mcp` 表） | **无内建**——须 extension 实现（TeamClaw extension 内桥接 amuxd-remote-tools） |
| 模型 | `/config/providers` 目录 | `get_available_models` / `set_model`；自定义 provider 用 `registerProvider`（LiteLLM 走 `openai-completions`，注意 compat 钩子） |
| 取消 | `POST abort` | `abort` 命令 |
| 安装分发 | 官方渠道 + `opencode.lock.json` | npm 包或 Bun 编译单二进制；同样做 `pi.lock.json` 最低版本锁 |

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
| `process.rs` | 每 worktree 拉起 `pi --mode rpc --session-dir ~/.amuxd/pi-sessions/<ws>`，env 注入（LiteLLM key 等），kill_on_drop，崩溃重启回退。进程池键 = canonical worktree（无 env 指纹——env 变更走进程重启） |
| `client.rs` | JSONL 命令写入 stdin（带 `id` 关联 response）：`prompt`（含 `streamingBehavior`）、`abort`、`set_model`、`get_available_models`、`switch_session`、`get_entries since`（断线补发） |
| `events.rs` | stdout 逐行解析（注意仅按 `\n` 切分，勿用通用行读取器），按当前会话路由 `AcpEventFrame` |
| `translate.rs` | `message_update.assistantMessageEvent`: `text_delta`→Output、`thinking_delta`→Thinking；`tool_execution_start`→ToolUse（toolCallId/toolName/args）、`_update`→ToolUse 进度、`_end`→ToolResult（isError 映射）；`turn_end`/`agent_settled`→回合完成 StatusChange；`extension_error`→AcpError |

### 权限审批（关键差异点）

pi 无内建权限。方案：随 daemon 分发一个 **TeamClaw pi extension**（TS 单文件，
安装到 `--extensions` 路径）：

1. extension 钩住全部工具执行（bash/edit/write 等）；
2. 按 TeamClaw workspace 权限规则（daemon 通过 env/配置文件传入）决定放行或询问；
3. 需询问时调 `confirm` dialog → pi 发 `extension_ui_request{method:"confirm"}`
   到 stdout → `pi_rpc/events.rs` 翻译为 `AcpPermissionRequest`（request_id =
   ui request id）→ 走既有 UI 审批 → `ResolvePermission` → 写回
   `extension_ui_response{confirmed}`；
4. gateway 会话（is_gateway）由 daemon 直接自动应答 confirmed=true。

“始终允许”语义在 extension 内记忆（per session/workspace 规则文件）。

### MCP / remote-tools

同一个 TeamClaw extension 内实现 MCP 客户端桥（pi 生态无内建 MCP）：
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
4. TeamClaw pi extension（权限门 + remote-tools MCP 桥）。
5. `pi_install`（对等 `opencode_install`：版本锁、doctor、安装/升级）。
6. tauri-mcp 桌面实测（对等本次 opencode 验收项）+ 文档。

## 6. 风险

- **pi 破坏性变更频繁**（两月 31 版、npm scope 迁移、v0.80 API 重构）：
  必须版本锁 + CI 里用锁定版本跑 translate 契约测试。
- **权限/MCP 全靠自带 extension**：extension API 本身也可能变；把 extension
  随 daemon 版本捆绑发布，不追 pi 上游 extension 生态。
- **单维护者上游**：issue 响应风格强硬，问题多半要自己修——必要时轻量 fork
  （只做 compat 修补，不像 opencode fork 那样背协议实现）。

# 单 Agent 化：官方 opencode + HTTP 集成迁移方案

> 状态：设计稿（2026-07-22）。决策背景：放弃多 agent（claude/codex/opencode over
> Zed ACP）兼容，仅保留**官方 sst/opencode**（不再维护 fork），amuxd 通过
> `opencode serve` HTTP API 驱动。附带一项客户端传输层合并改造（本机直连优先）。

## 1. 决策与理由

| 决策 | 理由 |
|---|---|
| 只保留 opencode 一个 agent | ACP 兼容层 ≈4–5k 行（`adapter.rs` 2418 行 + `translate.rs` 642 行 + `acp_host.rs` 等）维护成本过高；三后端的 per-agent 分支散落各处 |
| 用官方版，废弃 fork | fork（different-ai-studio/opencode）存在的唯一原因是 ACP；走 HTTP 后无需任何定制 |
| HTTP 直连，不用官方 SDK | SDK 是 TS 的，Rust daemon 用它要引入 Node 中间层；SDK 只是 OpenAPI 的机械封装，无增量价值 |
| 全局单 `opencode serve` 实例 | 已实测（opencode 1.17.7）：所有 session 端点带 `?directory=` 参数，会话按目录绑定 cwd，单实例可服务多 worktree |
| 不选 pi agent | 无内建权限系统（审批流需全部自建）、单维护者、破坏性变更频繁（两月 31 版、npm 命名空间整体迁移）、自定义 JSONL 协议无 OpenAPI 契约 |

已验证项：

- ✅ 权限审批可由外部 HTTP 客户端接管（团队此前已验证）。
- ✅ 单实例多目录（2026-07-22 实测，见 §8 注意事项）。

待验证项（非阻断）：

- ⬜ opencode 官方各平台二进制矩阵（尤其 Windows 原生）。
- ⬜ 官方 skills 机制与 `.teamclaw/skills` 的兼容性。

## 2. 目标架构与信息流

```
 Tauri 桌面 / iOS ── MQTT (EMQX, wss) ──┐
 本机客户端 ───────── amuxd HTTP ───────┤
 企业微信 ─────────── WeCom gateway ────┘
                                        ↓
                                 amuxd daemon
                          (RuntimeManager / 会话路由)
                                        ↓  HTTP + SSE
                        opencode serve（全局单实例, loopback）
```

**上行（用户消息 → agent）**：三个入口（MQTT RPC、amuxd 本地 HTTP、WeCom
gateway 的 `RuntimeHandle`）在 `RuntimeManager` 汇合后，统一变为一次
`POST /session/{id}/prompt_async?directory=<worktree>`。

**下行（agent 事件 → 用户）**：amuxd 持有一条全局 SSE 订阅（`/event`，事件带
sessionID），新翻译层把 SSE 事件映射为 `amux.proto` 的 `AcpEvent`（替代现
`translate.rs`），`turn_aggregator` 照旧聚合 Turn，再按会话归属分发：桌面/iOS
走 MQTT + 本地 SSE 快路径；WeCom 等 Turn 完成后由 gateway 回发。

**权限审批回路**：SSE 中的 permission 事件 → `AcpEvent` → 客户端审批 →
原路回 daemon → 调 opencode 权限应答端点。

协议边界不变：客户端与 gateway 只认 `amux.proto`，完全感知不到底层从 ACP
stdio 换成了 HTTP。

## 3. daemon 侧新模块：`runtime/opencode_http/`

| 组件 | 职责 | 替代 |
|---|---|---|
| `serve_supervisor` | spawn/守护全局 `opencode serve`（loopback + `OPENCODE_SERVER_PASSWORD`），健康检查、崩溃重启、版本校验 | `acp_host.rs` host pool、指纹键、evict 机制（整体删除） |
| `client` | OpenAPI 生成 types + 手写调用层（实际用到 ~10 个端点：session 创建/恢复、prompt_async、abort、权限应答、模型/配置） | `adapter.rs` 的 JSON-RPC 命令面 |
| `events` | 全局 SSE 订阅 + 断线重连 + 按 sessionID 路由 | `adapter.rs` 通知管线（`NotifInflightGuard` 等） |
| `translate` | SSE 事件 → `AcpEvent`（文本/思考/工具增量/权限/plan） | `adapter/translate.rs` |

要点：

- **路径规范化**：调用前对 worktree 路径做 canonicalize（macOS 上 `/tmp` →
  `/private/tmp`，否则 `?directory=` 过滤查空）。现 `worktree_fingerprint`
  的 canonicalize 逻辑可复用。
- **鉴权**：serve 必须设 `OPENCODE_SERVER_PASSWORD`（不设则无鉴权，日志有警告），
  密码由 daemon 生成、仅存于内存/`~/.amuxd`。
- **模型**：prompt 请求显式带 `{providerID, modelID}`，经 LiteLLM 网关
  （OpenAI 兼容端点；LiteLLM 侧需 `additional_drop_params` 兼容 reasoning 参数）。
- **MCP/skills**：经 opencode 配置注入（`opencode.json` 或 config API），
  替代现在的 strip/inject/snapshot 三套特判。

## 4. 可删除代码清单

daemon（`apps/daemon/`）：

- `runtime/adapter.rs`（2418 行）、`runtime/adapter/{translate,permission,envelope}.rs`
- `runtime/acp_host.rs`、`runtime/acp_catalog_probe.rs`（模型目录改查 serve 的 provider 端点）
- `agent-client-protocol` 依赖及三个 `unstable_*` feature
- `opencode_snapshot` 快照/恢复机制、`strip_remote_tools_mcp_for_opencode`、
  `ensure_remote_tools_baseline_mcp`、claude/codex 相关分支与
  `npx @zed-industries/claude-agent-acp` 包装、PATH enrichment workaround
- `ATTACH_TIMEOUT`/`HOST_INIT_TIMEOUT`/prompt-stall watchdog 中为 ACP 冷启动
  定制的部分（HTTP 侧用常规请求超时 + SSE 心跳重建）

`opencode_install/`：改回官方发布渠道下载（去 fork marker 校验），保留版本锁。

保留不动：`turn_aggregator.rs`、`amux.proto`（`AcpEvent` 结构沿用，避免动
客户端）、gateway 全部、MQTT 全部。预计净删 3–4k 行。

命名清理（随迁移顺手做）：gateway 的 `AcpHandle` trait 改名 `RuntimeHandle`
——它与 Zed ACP 无关，消除同名歧义。

## 5. 客户端传输合并（并入本方案）

**现状**：事件下行是双通道齐发（daemon 先写本地 SSE `/v1/live/events` 再发
MQTT，同一 `event_id`），前端在 `App.tsx` 按 `sessionId::eventId` 去重，先到
者赢——这是刻意冗余，成本低。**真正的问题在上行**：prompt/runtimeStart 等命
令只走 MQTT RPC（`teamclaw-rpc.ts`），本机 daemon 也要绕云端 EMQX 一圈。

**目标**：统一 `DaemonTransport` 选路层。

1. **本机 daemon**：命令走本地 HTTP（daemon 把 MQTT RPC handler 复用暴露为
   `POST /v1/rpc`，沿用现有 token 鉴权），事件走 SSE；MQTT 对该 agent 降级为
   兜底。
2. **远端 agent**：维持 MQTT 不变（iOS、团队成员观战、离线补发依赖它，daemon
   照旧双发）。
3. **选路依据**：复用设备可达性机制（`local-daemon-identity.ts` +
   `GET /v1/info` 探测 + 5s TTL 缓存，见
   `agent-device-reachability-and-runtime-ensure.md`）。
4. **降级**：本地 HTTP 连续失败自动回落 MQTT RPC，恢复后切回；eventId 去重保
   留，作为切换瞬间的双收保险。

改动点：daemon 新增 `/v1/rpc` 端点；前端 `teamclaw-rpc.ts` 加选路层。事件侧
不动。

## 6. 迁移步骤

参考 opencode removal（v2/amuxd-architecture）的硬切经验，不做双栈并行：

1. **阶段 0（准备）**：补两个待验证项（平台矩阵、skills 兼容）；OpenAPI spec
   固化一份进仓库（`docs/openapi/opencode-serve.json`）供生成 types 与 diff
   追踪上游变更。
2. **阶段 1（daemon）**：实现 `opencode_http` 四组件 + serve 守护；
   `RuntimeManager` 切换调用面；删除 §4 清单；`AgentType` 收敛为单值（proto
   枚举保留以兼容旧客户端）。
3. **阶段 2（传输合并）**：daemon `/v1/rpc` + 前端选路层（独立 PR，可与阶段 1
   并行开发）。
4. **阶段 3（清理）**：`opencode_install` 切官方渠道；文档更新（CLAUDE.md、
   CONTEXT.md、v2.md）；删除 UI 中的 agent 选择残留。
5. **验收**：daemon 测试 + E2E smoke；重点回归：冷启动时延（目标：告别 50–70s
   冷启动，serve 常驻后新会话秒级）、权限审批回路、WeCom 链路、断网本机可用性
   （阶段 2 后）。

## 7. 风险与对策

| 风险 | 对策 |
|---|---|
| opencode 发版快（1–2 天一版），API 变动 | 版本锁（沿用 `opencode.lock.json` 机制）+ 仓库内固化 OpenAPI spec 做 diff；升级走显式 PR |
| 仓库治理变动（sst → anomalyco 迁移迹象） | 关注 license 与发布渠道；版本锁保证可复现安装 |
| serve 单点崩溃影响所有会话 | supervisor 自动重启 + SSE 重连 + 会话恢复（serve 会话持久化在磁盘，重启后可续） |
| Windows 原生支持未证实 | 阶段 0 实测；最坏情况 Windows 端延后 |
| 旧 ACP 会话数据 | Turn 已持久化在 amuxd 侧，与 agent 协议无关；历史会话只读展示不受影响 |

## 8. 实测记录（2026-07-22, opencode 1.17.7）

- `GET /doc` 返回 OpenAPI 3.1；所有 session 端点带 `directory`/`workspace`
  查询参数。
- 同一 serve 实例在两个目录分别建会话成功，`directory` 各自正确；assistant
  消息 `path.cwd` 落在对应目录，工具执行上下文按会话隔离。
- 坑：目录过滤要求 canonicalize 后的路径；不设 `OPENCODE_SERVER_PASSWORD`
  则无鉴权。

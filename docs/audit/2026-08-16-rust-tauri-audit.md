# Rust / Tauri 全面排查报告（2026-08-16）

只读审计。范围：`apps/desktop`（31k 行 + tauri.conf/capabilities）、`apps/daemon`（92k 行）、
`crates/`（25k 行）、Cargo workspace 工程层。方法：四路并行深查（架构 / 性能 / 规范 /
Tauri 桌面端）+ 工程层人工核查，全部发现均有 file:line 证据，非热路径与刻意设计已剔除。

体量基线：daemon 从 #567（7/22，47k 行）到今天 92k 行，**不到一个月翻倍**。

---

## P0 — 安全（Tauri 桌面端）

### S1. 内嵌浏览器里的任意网页拿到全量 IPC + 全盘文件系统
`apps/desktop/capabilities/default.json:5-9,26-102` 唯一的 capability 同时包含
`"webviews": ["main", "wv-*", "ws-*", ...]` 和 `"remote": { "urls": ["https://*", "http://*"] }`，
而 `wv-*` 就是应用内浏览器（`commands/webview.rs:638` 用调用方给的 URL 建
`WebviewUrl::External`）。同一 capability 授了 `fs:allow-read/write/remove/rename`
带 `{ "path": "/**" }` 和 `$HOME/**`，assetProtocol scope 同样全盘。
外加 `withGlobalTauri: true`。**用户在内嵌浏览器里打开的任何第三方网页都能 invoke
全部 237 条命令、读写删本机任意文件**（`~/.ssh`、凭证库都在内）。

修法：capability 拆两份——特权版只给 `["main", "local-agent-panel"]` 且无 remote.urls；
`wv-*`/`ws-*` 用最小版（理想是什么都不给）。fs scope 收敛到真实 workspace 根。

### S2. `webview_eval_js` 无条件编进生产包，构成跨 webview 提权
`commands/webview.rs:469-539`，注释自称 "Debug-only"，但没有 `#[cfg(debug_assertions)]`，
`lib.rs:552` 正常注册。接收任意 `code: String` 在主窗口（特权前端）里 eval。与 S1 组合：
外部网页 → `invoke('webview_eval_js')` → 在主前端 origin 执行任意 JS。
修法：`#[cfg(debug_assertions)]` 门控或删除，自动化走 debug-only 的 tauri-mcp socket。

### S3. CSP 为空
`tauri.conf.json:35` `"csp": null`。前端任何一处 XSS 直接继承 S1 的全量能力。
纯配置修复，无 Rust 改动。

### S4. 回环 introspect API（:13144）零鉴权
`commands/introspect_api.rs:27-119`，`/env-var-set`、`/knowledge-delete`、`/send-wecom`、
`/mcp-put` 等路由对本机任意进程开放，peer 直接丢弃。修法：每次启动生成 bearer token
写 0600 文件，请求校验。

---

## P0 — 性能/正确性（daemon 单锁 + 单循环）

### D1. 全局 `Mutex<RuntimeManager>` 是唯一串行化点，且锁内做网络 IO 与进程 spawn
`daemon/server.rs:152`。`agents.lock().await` 93 处、11 个文件。实锤的锁内 IO：
- `runtime_lifecycle.rs:603` 持锁跑完 **opencode host 启动 + HTTP 握手**（manager.rs:790-815）
- `messaging.rs:391` 持锁打 opencode HTTP 往返（learn_session_model）
- `supervisor.rs:903-914` 持锁 probe catalog——旁边 `probe_default_workspace_catalog`
  的注释（manager.rs:1058-1060）恰好写明不该这么做，此处违反了自家规则
- `cron.rs:261`、`messaging.rs:629` 同类
HTTP 面不隔离：`http/runtime_adapter.rs:544` 与 MQTT 面共用同一把锁。
**任何一次 opencode 冷启动会同时冻结 MQTT、RPC、cron、HTTP——整个 daemon 单线程化。**
另有 `agents → agent_backend` 嵌套锁链 + `agent_backend_handle()` 外泄内层锁的锁序风险。
修法：registry 锁只护 map；IO 走 "checkout 句柄 → 放锁 → IO → checkin"
（`checkout_turn_for_acp` 已证明此模式在库内可行）。

### D2. 传输主循环内联执行一切
`server.rs:1757-2046` 单 `select!` 循环同时驱动 MQTT poll 和
`forward_agent_event`/`publish_actor_state`。后者每次执行：
无缓存 Cloud API GET（`get_agent_defaults`，cloud_api/mod.rs:1480）+
同步读写 opencode.json（supervisor.rs:234-242）+ 无缓存 opencode HTTP probe，
且 probe 在默认 workspace 无活 host 时**冷启动一个 opencode serve 进程**——这一切
发生在每个 Error/StatusChange/title/AvailableCommands 事件上，一个 turn 触发数次。
每条 turn-final 回复再串 1-2 次 Cloud API 往返（persist + cursor）。
修法：defaults/catalog 加缓存（env-revision 变更才重探）；presence publish 与
catalog probe 拆开；forward_agent_event 移出传输 select。

### D3. 每条消息全量重写 messages.toml —— O(N²)
`session_manager.rs:1036-1060` + `message_store.rs`：每持久化一条消息就
read_to_string → 全量 parse → append → `toml::to_string_pretty` 全量重写，
同步 std::fs，在事件循环里。几千条消息的会话每条新消息都重序列化整个历史。
同族问题：`history/store.rs:33-53` 每事件重开文件写两次；`messaging.rs:291,375,408`
每个 status/tool-use 事件全量重写 runtimes.toml。
修法：append-only（`history/` 已有长度前缀追加的先例）或内存态 + 脏标记去抖。

### D4. 轮询代替通知
- `server.rs:1980-2043`：50ms 轮询泵是每个 delta 批次的延迟地板
- `http/runtime_adapter.rs:590-635`：10ms interval 永久自旋，每 tick 取全局锁一次、
  每帧再取一次，与 D1 的长持锁互相踩
修法：manager 入队处发 `Notify`/watch，50ms tick 只留作 MQTT 断线去抖。

---

## P1 — 架构

### A1. RuntimeManager 是 God object：10 类职责、80+ pub 方法
`runtime/manager.rs` 3599 行。spawn/catalog/MRU/prompt 拼装/turn checkout/presence/
gateway 会话/proto 序列化/context 注入/host 驱逐全在一个 struct 上——这正是 D1 一把锁
的根因。连硬编码模型表（`model_id_for_short_name`:190）都在里面。
先拆低耦合三块：catalog+MRU、presence 快照、模型解析表，各配细粒度锁。

### A2. MQTT/NATS 两条主循环手工复制，`run()` 单函数 1143 行
`server.rs:905`（run）与 `:2064`（run_nats），后者注释自认 "Parallel to the MQTT path
above"。DaemonServer 33 个字段，server.rs + 子模块 ≈ 1.1 万行单类型。token 刷新/重连/
resubscribe 要改两遍。修法：以 teamclu-transport 为界抽 Transport trait，主循环写一遍。

### A3. 四个命令入口面各自 dispatch，一致性靠一条测试硬顶
MQTT（messaging.rs）、NATS、Unix socket（handle_control_conn 357 行）、
HTTP（runtime_adapter.rs 1991 行）。`server.rs:3966` 测试名即自白：
`all_actual_entry_points_propagate_identical_workspace_env_and_revision`。
修法：parse → Command enum → 单 executor。

### A4. ACP 词汇债 + runtime_id 三名同物（#607 现状确认）
非 proto 文件 "acp" 1240 次；`runtime_id`/`agent_id`/`session_id` 是同一字符串
（manager.rs 注释 "The key IS the session"），`runtime_ids_for_session` 返回
`vec![session_id]` 的假 1:N 形状。proto 名已冻结不动；内部批量改名 + `SessionKey`
newtype，一次机械 PR。

### A5. 错误字符串是跨仓 wire 契约
`AmuxError::Agent(String)` 105 处；error.rs 注释明言 `agent_binary_missing(<agent>)`
是 wire contract，desktop 的 ensure-agent-runtime.ts 在 substring-match 它；
desktop 侧同样有 `ERR_TEAM_GATE_MISMATCH` 魔法字符串（local_cache/commands.rs:50）。
改措辞=悄悄打断客户端。修法：wire 上加结构化 error code，字符串只给人看。

### A6. daemon 编译期反向依赖前端包
`runtime/supervisor.rs:20,46,52,62` `include_str!("../../../../packages/app/src/...")`。
前端挪文件 = daemon 编译挂。对照 pi 扩展已做对（include daemon 自己的 assets/）。
资产下沉 `apps/daemon/assets/` 或独立资产 crate。

### A7. `#[cfg(test)]` fork 生产路径
`manager.rs:1300-1374` `send_prompt_raw` 整段测试假实现，单测验证的是另一个程序。
挪进 test_support 的 AgentBackend 测试实现（CapturingBackend 机制现成）。

### A8. 桌面端杂项
- `local_cache/store.rs`：单 `Mutex<Connection>` 串行化 60+ 命令，无 WAL/busy_timeout
- sidecar 生命周期分散 4 处，SIGKILL/panic 后 amuxd 成孤儿（无 parent-PID watchdog）
- ~20 条 IPC 命令零调用方（`greet`、legacy daemon installer 三件套等），
  `lib.rs:3-4` 的 `#![allow(dead_code, unused_imports)]` 把报警全按掉了
- 四套 install/doctor 平行模块无共享契约（对照运行时侧 AgentBackend trait 已做对）

---

## P1 — 工程/规范

### H1. 立刻可修：teamclu-introspect 的 test target 编译不过
`introspect/src/main.rs:644-671` 四个测试调用已被 #905 删掉的 `fetch_credential`
（custom_git 残骸）。这也是全仓 `--workspace --all-targets` clippy/test 跑不动的原因。

### H2. CI 守卫缺口是 daemon 175 条 warning 的直接成因
唯一的 clippy/fmt 检查（ci.yml:119-122）只盯 apps/desktop 包本身——被 `-D warnings`
守着的 desktop 是 0，没人守的 daemon 是 175（半数纯机械：unused_imports 36、
needless_return 7…）。**其中 `clippy::await_holding_lock` × 4 是正确性级别**
（workspace_resolver.rs:845、server.rs:3194、sync/dispatch.rs:217,248），需人工逐个过。
零成本第一步：给已经 0 warning 的 6 个 crate 先加 `-D warnings` 锁现状。

### H3. daemon 集成测试 `#[path]` include 整个 src
6 个测试二进制各自全量重编 daemon 源码，制造 6 倍编译 + ~85 条 dead_code 假阳性。
拆 lib target 让集成测试 `use amuxd::…`，两个问题一起消失。

### H4. 日志与 panic 面
- gateway 库 300+ 处 println!/eprintln! 当日志（email.rs 78、wecom.rs 53…），
  channels/manager.rs 同病；统一迁 tracing
- `terminal/pty.rs` 12 处 `lock().unwrap()`：reader 线程 panic 会 poison 锁，
  后续所有终端操作连锁 panic；仓库已有 38 处反毒化惯用法，此文件没用
- `opencode_paths.rs:160-169` 自造 HomeGuard **drop 时删 HOME 而非恢复原值**且无锁
  ——顺序敏感测试的真源头；3 处测试改 PATH 没加锁同类
- `Result<_, String>` ~815 处；定规矩：String 只许出现在 `#[tauri::command]` 签名，
  内层 thiserror

### H5. Cargo 工程层
- `workspace.dependencies` 几乎未使用（全部 Cargo.toml 共 5 处 `workspace = true`），
  `cargo tree -d` 262 个重复版本条目
- release profile 被一个 gateway 适配器绑架：email.rs 的 IMAP IDLE `catch_unwind`
  （email.rs:939）迫使全 workspace `panic=unwind` + `lto=false`；imap-proto 0.10.2
  已在 future-incompatibilities 名单
- gateway 七个适配器 16.6k 行，backoff/heartbeat/轮询循环各写各的，共享 trait 只有
  两个薄接口
- 启动路径：doctor 无缓存重复 spawn（diagnostics 一次打包 2 spawn ≈ 冷 8s）、
  daemon boot 两次串行 Cloud RTT 先于 HTTP bind（server.rs:576-635，而 :911-926
  的注释说明同类问题已修过一半）

### H6. 文档过期
- CLAUDE.md 仍列 `apps/desktop/crates/teamclu-stt/`（Whisper STT），该 crate 已不存在
- `http/runtime_adapter.rs` 模块头 "can ship in a follow-up PR" 已落地未更新

---

## 建议动手顺序

1. **S1-S3 一个 PR**：capability 拆分 + eval_js 门控 + CSP。纯配置+一行 cfg，
   收益/成本比全场最高，且是真实漏洞。
2. **H1 一个小 PR**：删 4 个死测试，解锁全仓 clippy/test。
3. **D1 锁外 IO 改造**（架构组与性能组共同的第一名）：不拆 God object 也能先做，
   套用库内已有的 checkout/checkin 模式。
4. **D3 消息持久化 append 化**：独立、可测、收益明确。
5. **H2 CI 守卫**：6 个干净 crate 先锁，daemon 清完机械 warning 后入守。
6. A1/A2/A3 的拆分是长期工程，建议按 issue 拆单独立推进；A4 改名是一次机械 PR
   可随时插队。

## 审计中顺手核实的非问题（避免后人重查）

- desktop 的 `reqwest::blocking` 都正确包在 spawn_blocking 里
- email 网关的 `thread::sleep` 在独立 std 线程上
- cloud_api 的 10 处 expect/unreachable 是刻意语义（token poisoning / retry 后断言）
- unsafe 面 58 处 grep 命中基本全是测试 env::set_var，带 SAFETY 注释
- `#[ignore]` 全仓仅 1 处且有理由
- sidecar 正常退出路径的回收逻辑是认真写的（zombie-aware liveness + 进程组
  SIGTERM→SIGKILL），缺口只在硬崩溃场景

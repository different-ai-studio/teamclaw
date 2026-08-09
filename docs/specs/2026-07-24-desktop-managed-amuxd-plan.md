# 实现计划：桌面托管 amuxd（仅跟随桌面）

> 依据：[`docs/specs/2026-07-24-desktop-managed-amuxd-design.md`](./2026-07-24-desktop-managed-amuxd-design.md)（已确认）  
> 日期：2026-07-24  
> 约束：禁止 worktree；在当前分支直接改。

---

## 总览

把 amuxd / teamclu-introspect 从「拷到 `~/.amuxd/bin` + install-service」改为「桌面持有 sidecar 子进程，Exit 时 stop」。

```text
P0  验证 start 前台语义 + AmuxdSupervisor + Exit stop + 卸旧服务
P1  注入 INTROSPECT_BIN；前端 onboard/heal/Setup 改走 supervisor
P2  删升级拷贝；文案与文档；可选清旧 bin/
```

每步可单独验证；P0 合入后旧服务用户即可迁移。

---

## P0 — 进程托管骨架

### 0. 验证 `amuxd start` 语义（阻塞）

- [ ] 本地跑 `amuxd start`：是否前台占用、是否写 pid、Ctrl+C / SIGTERM 是否干净退出。
- [ ] 若已 daemonize / 立刻返回：加 `amuxd start --foreground`（或等价），桌面只用该模式。
- [ ] 文档化结论写进设计稿 §10.1。

### 1. `AmuxdSupervisor`（`apps/desktop`）

新模块建议：`apps/desktop/src/commands/amuxd_supervisor.rs`（或 `daemon_lifecycle.rs`）。

- [ ] `AppState` 持有：`child`、`started_at`、锁。
- [ ] `ensure_started(app)`：
  - 已有 child 且未退出且 HTTP healthy → ok
  - 否则：先 `stop_stale_external()`（见下），再 `shell().sidecar("amuxd").args(["start" | "--foreground"]).env(TEAMCLU_INTROSPECT_BIN, …).spawn()`
  - 轮询 `amuxd.http.port` + healthz（超时 ~20s）
- [ ] `shutdown()`：sidecar `stop` 或 SIGTERM → `wait_for_amuxd_stopped(5s)` → kill child
- [ ] `restart()`：shutdown + ensure_started
- [ ] `lib.rs`：`RunEvent::ExitRequested` 调 `shutdown()`（与 terminal kill_all 并列）；**不要**在「仅关窗口」时 stop

### 2. 迁移：卸旧服务 + 杀残留

- [ ] `stop_stale_external()`：
  1. 若 LaunchAgent / systemd / 计划任务存在 → sidecar `uninstall-service`（失败打日志）
  2. sidecar（或 pidfile）`stop` + wait
- [ ] 在 **第一次** `ensure_started` 前调用

### 3. Tauri 命令

- [ ] `daemon_ensure_running`
- [ ] `daemon_restart_managed`
- [ ] `daemon_supervisor_status` → `{ running, healthy, pid?, error? }`
- [ ] `daemon_install_service` → **兼容层**：转调 `daemon_restart_managed`（或 ensure），避免旧前端炸

### 4. Setup 路径停拷贝

- [ ] `install_amuxd`：不再 `copy_sidecar_into_amuxd_bin`；改为 `ensure_started`（或 Setup 不再装 amuxd）
- [ ] `setup_list_requirements`：`amuxd.present` = bundled sidecar 可用（doctor 对 sidecar），不看 `~/.amuxd/bin`

**验收 P0：** 开 App → healthz 通；Cmd+Q → pid 消失；旧 plist 被卸；无新文件写入 `~/.amuxd/bin/amuxd`。

---

## P1 — Introspect 注入 + 前端改线

### 5. Daemon 解析 introspect

- [ ] `resolve_introspect_binary()`（`apps/daemon/src/runtime/supervisor.rs`）：**优先** `std::env::var("TEAMCLU_INTROSPECT_BIN")`，再 PATH / `~/.amuxd/bin` / bundle 搜索
- [ ] 单测：env 优先

### 6. 桌面 spawn 时注入

- [ ] 用 `locate_bundled_introspect()`（已有）得到绝对路径，设 `TEAMCLU_INTROSPECT_BIN`
- [ ] 确认 MCP 配置写入的 command 为该绝对路径（跟随 ensure_inherent_config）

### 7. 前端 onboarding / heal

- [ ] `daemon-onboarding.ts`：`onboard` / `ensureHealthy` / `autoHeal` 不再依赖「真·install-service」语义；改为 `daemon_ensure_running` / `daemon_restart_managed`
- [ ] `forceReset`：先 `daemon` stop（ensure 的 inverse 或新 `daemon_stop_managed`）→ `daemon_clear` → refresh
- [ ] 更新相关 vitest mocks

### 8. SetupWizard / deps

- [ ] 去掉 amuxd「安装/升级拷贝」UI 与 auto-install；保留 opencode / git
- [ ] Settings Dependencies：amuxd 行改为「随 App 运行 / 重新启动」

**验收 P1：** init 后 agent MCP 能调到 introspect；heal/reset 不撞 lock；Setup 无拷贝进度。

---

## P2 — 收尾

### 9. 删除升级拷贝

- [ ] `ensureBundledAmuxdCurrent` 空实现或删除调用（`main.tsx`）
- [ ] 删/改 `daemon-version-upgrade` 测试

### 10. 文档与文案

- [ ] 更新 `docs/amuxd-home-directory.md`：`bin/` 不再由桌面维护；补充托管模式
- [ ] 设计稿状态保持「已确认」；本计划勾选完成项
- [ ] Daemon 设置文案：「后台服务」→「随 TeamClu 运行」

### 11. 可选清理

- [ ] 迁移成功后可选删除 `~/.amuxd/bin/amuxd` 与 `teamclu-introspect`（保留目录无妨）

**验收 P2：** 新装无 bin 拷贝、无 LaunchAgent；升级只换 App；文档一致。

---

## 风险检查清单

| 项 | 动作 |
|----|------|
| `start` 是否前台 | P0.0 必验 |
| force kill 孤儿 | 下次 ensure 前 stop |
| 开发热重载双实例 | supervisor 单例 + lock |
| Windows 计划任务残留 | uninstall-service 覆盖 |
| CI / e2e 假设服务常驻 | 改「先起桌面再测」或显式 ensure |

---

## 建议提交切分

1. `feat(desktop): AmuxdSupervisor + exit stop + legacy uninstall`
2. `feat(daemon): prefer TEAMCLU_INTROSPECT_BIN`
3. `feat(app): onboard/heal/setup use managed daemon`
4. `chore: remove amuxd bin copy upgrade path + docs`

---

## 开始前

等你说 **「按计划实现」** 或指定先做 P0 后，再改代码。

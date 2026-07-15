# 统一安装 + 首启引导设计 (Desktop / amuxd / opencode / git)

- 日期: 2026-06-02
- 分支: `agent/unified-install-onboarding`
- 状态: 设计草案 (待评审)

## 1. 背景与目标

TeamClaw 桌面端目前把三块东西完全分离:

| 组件 | 现状安装/启动 | 是否随包 |
|---|---|---|
| Desktop (Tauri) | 下载 `.dmg`/`.exe` 安装 | 只捆绑 `teamclaw-introspect` + askpass (`tauri.conf.json` `externalBin`/`resources`) |
| amuxd (daemon) | 用户手动 `amuxd init` + `amuxd start`,桌面靠读 `~/.amuxd/amuxd.http.{port,token}` 发现 | 否 |
| opencode | 手动跑 `download-opencode.sh`(依赖 `gh` CLI),>100MB | 否 |

痛点:`install_local_daemon()` / `daemon_status()` / `uninstall_local_daemon()` 全是 `not_implemented`
(`apps/desktop/src/commands/daemon_installer.rs`);没有"一步步把环境装好"的引导;没有 health-check /
自动修复;opencode 获取依赖开发者工具链。

**目标**:桌面装完、首次启动出现**图形化引导向导**,一步步把 **git / opencode / amuxd** 准备好;登录后
**自动驱动 daemon 的团队 onboarding**(新建或绑定 agent)。覆盖 **macOS + Windows + Linux**。

**非目标**:静默零交互安装;改动桌面↔daemon 的通信层(继续走本地 HTTP + 文件发现)。

## 2. 锁定的关键决策

1. **交付策略 = 混合**:第一方 (amuxd) 随包捆绑;第三方 (opencode) 按需下载(带 CN 镜像);git 检测+引导。
   - **opencode 归 amuxd**(§9 开放问题 1 已查清):#283 之后 opencode 完全由 amuxd 拉起(`opencode serve`
     做 provider OAuth、`opencode acp` 做聊天会话),desktop 的 `opencode.rs` 是 dead code。因此 opencode 的
     **下载/校验/版本逻辑放进 amuxd**(`apps/daemon`),装到 `~/.amuxd/bin/opencode`;desktop 首启向导只是
     **调用捆绑的 amuxd CLI** 触发安装并渲染进度。
2. **git = 可跳过**:检测不到就引导安装,但允许跳过,不阻断进入 app。
3. **amuxd = 常驻后台服务**:登录 + invite 之后注册为 launchd / systemd-user / 计划任务,开机自启,app 关闭后继续跑(承载 push/MQTT/cron)。
4. **实现路线 = 路线 B**:Rust 侧声明式 Setup Engine + 前端只渲染;逻辑同时暴露成 `amuxd doctor` CLI。
5. **安装 ≠ 启动**:首启向导只**安装二进制**;amuxd 的 **init + 注册服务 + start** 发生在登录后的团队 onboarding。
6. **团队 onboarding 由桌面 app 自动驱动**:app 已登录且为 owner,可自动建 invite → 喂给 `amuxd init`,无需 QR/粘贴。
7. **绑定已有 agent v1 就做全**:新增"为已有 agent 重发 invite"端点,新建/绑定两条路一起上。

## 3. 总体生命周期

```
┌─ 阶段一: 首启安装向导 (Setup Engine, §4) ───────────────┐
│  detect + install:  git(可跳过) · opencode · amuxd      │
│  amuxd 仅复制二进制到 ~/.amuxd/bin/,不注册服务、不启动    │
└────────────────────────────────────────────────────────┘
                          ↓
                   用户登录 (cloud auth)
                          ↓
┌─ 阶段二: 团队 onboarding (app 自动驱动, §6) ────────────┐
│  按 daemon 当前 team_id 进入: 新建 / 绑定 / 强制重置      │
│  → amuxd init(写身份) → 注册服务 + start                 │
│  → 服务写 ~/.amuxd/amuxd.http.{port,token}               │
│  → POST /v1/team/link 立刻物化团队目录                    │
└────────────────────────────────────────────────────────┘
                          ↓
        桌面 daemon_http.rs 读文件发现 daemon → 正常使用
```

职责切分:**Setup Engine** 只管"东西在不在"(纯安装/检测/修复,不碰身份);**团队 onboarding**
管"身份与启动"。

## 4. Setup Engine (Rust 侧,路线 B)

新模块 `apps/desktop/src/setup/`。核心是声明式 `Requirement`:

```rust
enum ReqStatus { Ok { version: Option<String> }, Missing, NeedsUpdate, Failed(String) }

trait Requirement {
    fn id(&self) -> &str;            // "git" | "opencode" | "amuxd"
    fn title(&self) -> &str;         // 展示名
    fn optional(&self) -> bool;      // git=true, opencode/amuxd=false
    async fn detect(&self) -> ReqStatus;                    // 幂等检测
    async fn install(&self, p: ProgressSink) -> Result<()>; // 带进度
    async fn verify(&self) -> ReqStatus;                    // 装后复检
}
```

三个实现,平台分支收敛在各自内部:

| Requirement | detect | install | optional |
|---|---|---|---|
| `GitReq` | `git --version` | mac: 触发 `xcode-select --install` / 提示 brew;win: 引导 winget/installer;linux: 提示发行版包管理器 | ✅ |
| `OpenCodeReq` | 调 `amuxd doctor --json` 看 opencode 状态(逻辑在 amuxd) | 调 `amuxd install-opencode`(见 §5),桥接进度到向导 | ❌ |
| `AmuxdReq` | 捆绑二进制是否已复制到 `~/.amuxd/bin/amuxd`(仅"装好",不查服务) | 把随包的 amuxd 复制到 `~/.amuxd/bin/`,mac 去隔离+ad-hoc 签名 | ❌ |

> **安装顺序**:`AmuxdReq` 必须先于 `OpenCodeReq`——opencode 的安装逻辑在 amuxd CLI 里,得先有 amuxd
> 二进制可调。向导顺序:amuxd(复制二进制)→ opencode(经 amuxd CLI 下载)→ git(可跳过)。opencode 安装
> 不需要团队身份,可在阶段一完成。

**对外双入口、共用引擎:**
- Tauri commands:`setup_list_requirements()` / `setup_install(id)` / `setup_verify_all()` —— 重写替换
  `daemon_installer.rs` 现有三个 `not_implemented` 桩。
- CLI:`amuxd doctor`(只读检测) / `amuxd install-service`(在 §6 用到的服务注册)。

**重入 / 修复天然支持**:向导每次进来先 `detect()` 全部,已 OK 显示绿勾跳过,只对 Missing/NeedsUpdate
执行 install。这同时就是缺失的 health-check + 自动修复流程。

**前端**:新增 onboarding 向导组件(参考现有 `DesktopOnboarding.tsx` 的位置),只负责拉 requirement
列表、展示状态、触发 install、轮询进度。

## 5. opencode 下载器 + CN 镜像 + 版本固定(归 amuxd)

opencode 由 amuxd 拉起,所以下载/校验/版本逻辑放进 **amuxd**(`apps/daemon/src/opencode_install/` 之类),
对外暴露为 CLI:`amuxd install-opencode` / `amuxd doctor`(只读检测)。desktop 首启向导经捆绑的 amuxd CLI
调它并渲染进度;同一逻辑也供任意客户端 / 纯 CLI 复用。

现有 `download-opencode.sh` 依赖 `gh` CLI(终端用户没有)且无 Windows target,运行期必须纯 Rust 直连。

**版本固定 (single source of truth)**:新增 `apps/daemon/opencode.lock.json`(随 amuxd 编译进二进制或随
`~/.amuxd/` 分发):

```json
{
  "version": "v1.2.3",
  "assets": {
    "aarch64-apple-darwin":     { "name": "opencode-darwin-arm64.zip", "sha256": "..." },
    "x86_64-apple-darwin":      { "name": "opencode-darwin-x64.zip",   "sha256": "..." },
    "x86_64-unknown-linux-gnu": { "name": "opencode-linux-x64.tar.gz", "sha256": "..." },
    "aarch64-unknown-linux-gnu":{ "name": "opencode-linux-arm64.tar.gz","sha256": "..." },
    "x86_64-pc-windows-msvc":   { "name": "opencode-windows-x64.zip",  "sha256": "..." }
  }
}
```

> ⚠️ **风险**: 需确认 `anomalyco/opencode` 是否发布 Windows / linux-arm64 资产。若没有,Windows 平台的
> opencode 步骤需降级为"暂不支持/手动"或推动上游出包。

**`amuxd install-opencode` (纯 Rust,amuxd 内):**
1. 选源:默认 `github.com/anomalyco/opencode/releases/download/<ver>/<asset>`;CN 走阿里云 OSS 镜像
   (复用 `install-mac-cn.sh` 的 OSS 链路,发版时把 opencode 资产一并镜像)。
2. 下载到临时目录,**进度输出**(stdout JSON 行 → desktop 桥接到向导进度条);**校验 sha256**。
3. 解压 (zip / tar.gz),把 `opencode` 放到 **`~/.amuxd/bin/opencode`**(amuxd 能发现的稳定路径)。
4. macOS:`xattr -cr` + `codesign --force --sign -`(照搬脚本 line 81-83)。
5. 写 `~/.amuxd/.opencode-version`,跑 `opencode --version` 复检。

**amuxd 二进制发现**:amuxd 现在用 `command -v opencode`(PATH)或 daemon.toml `[agents.opencode].binary`
绝对路径(`pool.rs:142` / `server.rs:1042`)。需让 amuxd **优先选 `~/.amuxd/bin/opencode`**(若存在),或在
`amuxd init` 时把该绝对路径写入 `daemon.toml [agents.opencode].binary`,确保装到的 opencode 一定被用上。

**镜像选择**:先试官方源,超时/失败自动 fallback 到 OSS 镜像;或在向导给"中国大陆网络"开关。

**清理**:desktop 的 `apps/desktop/src/commands/opencode.rs` 已是 dead code(命令未在 `lib.rs` 导出、
`externalBin` 无 opencode),本设计落地时一并删除或标记 legacy。

## 6. amuxd 捆绑 + 服务注册 + 团队 onboarding

### 6.1 捆绑(随包)
- `tauri.conf.json` `bundle.externalBin` 追加 `binaries/amuxd`(当前仅 introspect)。
- 构建期仿 `ensure-introspect-sidecar.js` 新增 `ensure-amuxd-sidecar.js`:tauri build 前
  `cargo build -p amuxd --release --target <triple>` → copy 成 `binaries/amuxd-<triple>`。
- `release.yml`(当前 line 105-113 只编 introspect)增加 amuxd 双 arch 编译。
- 运行时定位复用 `opencode.rs` 的 `resolve_executable()`(生产=主程序旁,开发=`apps/desktop/binaries/`)。

### 6.2 服务注册(在团队 onboarding 之后,不在安装向导)
`AmuxdReq.install()` 只把二进制复制到 `~/.amuxd/bin/amuxd`(稳定路径,避免 app 升级/移动导致服务路径失
效)。**注册服务 + 启动**发生在 `amuxd init` 成功后:

| 平台 | 机制 | 落点 | 自启 |
|---|---|---|---|
| macOS | LaunchAgent | `~/Library/LaunchAgents/cc.ucar.amuxd.plist` → `launchctl bootstrap` | `RunAtLoad` + `KeepAlive` |
| Linux | systemd **user** unit | `~/.config/systemd/user/amuxd.service` → `systemctl --user enable --now` + `loginctl enable-linger` | 开机(linger) |
| Windows | 计划任务 (`schtasks /SC ONLOGON` / `Register-ScheduledTask`) | 用户级,无需管理员 | 登录 |

> 选用户级计划任务而非 Windows Service:Service 要管理员权限,破坏零摩擦体验;用户级登录自启足够
> push/MQTT。

### 6.3 团队 onboarding 状态机(登录后,app 自动驱动)

底层事实(已验证):
- `amuxd init <invite-url>`(`teamclaw://invite?token=...`)→ POST `/v1/invites/claim` → 写
  `backend.toml`(team_id/actor_id/refresh_token)+ `daemon.toml`(device.id=actor_id、team_id)。
  它**绑定一个已存在的 agent**,不凭空建。
- 建 agent 在更早:RPC `create_daemon_invite(team_id, display_name)` → 建 actor+agent(status=invited)
  → 返回 invite_token。
- app 已登录且为 owner → 可全自动:调"建 invite"拿 token → Tauri shell 跑 `amuxd init` → 无需 QR。

```
get_daemon_team_id()   (读 ~/.amuxd/daemon.toml)
   │
   ├─ null(未初始化) ─► 弹「初始化本机 Agent」
   │     ├─ 新建 agent: 输入 名字 + 可见性(team/personal)
   │     │     └► 建 invite → amuxd init → 注册服务+start → POST /v1/team/link
   │     └─ 绑定已有 agent: 列「当前 team + 当前用户 owner」的 agent 选一个
   │           └► 为该 agent 发 invite → amuxd init → 注册服务+start → team/link
   │
   ├─ == 当前登录 team_id ─► 已就绪,直接用
   │
   └─ != 当前登录 team_id ─► 强制重新初始化
         └► amuxd clear → 回到「未初始化」分支
```

复用现成的:`get_daemon_team_id` / `get_daemon_http_info`(`daemon_http.rs`)、`DaemonGeneralSection.tsx`
的 `teamMismatch` 判定(从"黄条提示"升级为"强制重置")、`AgentVisibility` 类型、`POST /v1/team/link`
(#287)、`PATCH /v1/agents/{id}`(改可见性,owner-only)。

## 7. 新增后端端点(Cloud API,按 CLAUDE.md OpenAPI-first 流程)

按 CLAUDE.md:先写 `docs/openapi/teamclaw-api.v1.yaml` → repository-contract → business-api 路由 →
supabase-repo passthrough(以及进行中的 postgres 后端)→ FC 测试 → 客户端 provider。

**端点 A —— 新建 agent(含可见性)**
`POST /v1/teams/{teamId}/agents`,body `{ name, visibility: "team"|"personal" }`,内部建 agent + 一次性
invite,返回 `{ agentId, inviteToken }`。
> 现状缺口:`create_daemon_invite` 不收 visibility 且是 Supabase RPC,前端不能直连(后端边界)。本端点
> 包装它,并在建后置 visibility(或下沉到 RPC 参数)。

**端点 B —— 为已有 agent 重发 invite**
`POST /v1/agents/{agentId}/invite`,owner-only,为已存在 agent 签发一次性 invite token,返回
`{ inviteToken }`。app 用它走同样的 `amuxd init`,实现"绑定已有 agent / 多设备"。

**列表(可能已存在,确认即可)**:`GET /v1/teams/{teamId}/actors?kind=agent`,前端按 `isOwner`
(created_by_member_id = 当前 member)过滤出可绑定列表。

## 8. 受影响 / 新增文件清单

新增:
- `apps/desktop/src/setup/`(mod + 三个 Requirement + Tauri commands;OpenCodeReq 委托 amuxd CLI)
- `apps/daemon/src/opencode_install/`(纯 Rust 下载器)+ `apps/daemon/opencode.lock.json`
- `scripts/ensure-amuxd-sidecar.js`
- amuxd CLI 子命令:`doctor`(只读检测) / `install-opencode`(下载 opencode) / `install-service`
  (注册后台服务)/ `clear`(已存在,重置用)(`apps/daemon/src/cli/` + 服务注册模块)
- 前端 onboarding 向导组件 + daemon onboarding 状态机 store
- FC:端点 A / B 的 openapi + contract + 路由 + repo + 测试

改动:
- `apps/desktop/src/commands/daemon_installer.rs`(三个 `not_implemented` → 实装,或迁入 setup 模块)
- `apps/desktop/src/commands/opencode.rs`(dead code,删除或标记 legacy)
- `apps/desktop/tauri.conf.json`(`externalBin` 加 amuxd)
- `apps/daemon/src/daemon/server.rs` / `opencode_settings/pool.rs`(opencode 二进制发现优先 `~/.amuxd/bin/`)
- `.github/workflows/release.yml`(amuxd 双 arch 编译)
- `packages/app/src/components/settings/DaemonGeneralSection.tsx`(team mismatch 升级为强制重置入口)
- `docs/openapi/teamclaw-api.v1.yaml`

## 9. 开放问题 / 风险

1. ~~**opencode 归属**~~ **[已查清 2026-06-02]**:#283 之后 opencode **完全由 amuxd 拉起**——
   `opencode serve`(provider OAuth/发现,`opencode_settings/pool.rs:83`)+ `opencode acp`(聊天会话,
   `runtime/adapter.rs:1151`);amuxd 经 `command -v opencode` 或 daemon.toml `[agents.opencode].binary`
   发现。desktop 的 `opencode.rs` 是 dead code。**结论:opencode 安装器归 amuxd,落 `~/.amuxd/bin/opencode`**
   (已并入 §2 决策 1、§4、§5、§8)。
2. **opencode Windows/linux-arm64 资产**:上游是否发布?否则对应平台步骤需降级。
3. **后端 Supabase vs Postgres**:FC 去 Supabase 化进行中(`BACKEND_KIND=postgres`),端点 A/B 需在两条
   后端路径都实现(或至少 supabase passthrough + 进行中的 postgres)。
4. **多设备绑定语义**:同一 agent_id 绑多机当前是否被 EMQX ACL / device.id 唯一性支持,需在端点 B 落地
   前确认。
5. **Linux 发行版差异**:git 引导与 systemd-user(无 systemd 的发行版/容器环境)需兜底文案。

## 10. 验收标准

- 全新机器:装完桌面 → 首启向导能 detect 出 git/opencode/amuxd 状态,缺的能装好(git 可跳过)。
- 登录后:未初始化 daemon 自动进 onboarding,可"新建 agent(名字+可见性)"或"绑定已有 agent",成功后
  amuxd 注册为后台服务并自启,桌面能发现并使用。
- team_id 与登录用户不一致时强制重置并重新 onboarding。
- `amuxd doctor` CLI 可在无 UI 下报告各依赖状态。
- 三平台(mac/win/linux)各跑通一遍主链路(Windows opencode 视风险 2 结论)。

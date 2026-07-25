# `~/.amuxd` 目录说明

本机 Agent Daemon（`amuxd`）的家目录。桌面版安装 / onboard 后，长期运行的二进制、身份配置、团队共享内容、运行时索引都落在这里。

路径：`$HOME/.amuxd`（Windows 同理，在用户主目录下）。

> **一句话**：这里是「本机小助手」的身份证、工具箱和仓库，不是云端聊天记录的主库。聊天列表和消息主要在 Cloud API；这里更多是本机身份、进程控制和团队同步副本。
>
> **桌面托管模式（2026-07）：** 桌面 App 直接 spawn 包内 `amuxd` / `teamclaw-introspect` sidecar，**不再**拷贝到 `bin/`，也**不**注册开机自启。App 退出则 stop。`bin/` 若仍存在多为旧版残留，可忽略。

---

## 目录总览

```text
~/.amuxd/
├── bin/                          # 【遗留】旧版拷贝的可执行文件；桌面托管模式不再使用
│   ├── amuxd
│   └── teamclaw-introspect
├── daemon.toml                   # 本机 daemon 配置（含 team_id）
├── backend.toml                  # 云端登录凭证
├── members.toml                  # 本地成员/邀请缓存（协作相关）
├── sessions.toml                 # 本机 agent runtime 索引（可恢复上下文）
├── workspaces.toml               # 【遗留】已不再作为真相源
├── amuxd.pid / amuxd.lock        # 进程存活与单实例锁
├── amuxd.sock                    # 本机控制通道（Unix）
├── amuxd.http.port / .http.token # 本机 HTTP API 发现与鉴权
├── amuxd.cloud-token             # 给子进程用的短期 cloud JWT 文件
├── amuxd.managed.log             # 【现行】桌面托管 amuxd 的 stdout/stderr
├── amuxd.out.log / amuxd.err.log # 【遗留】旧 LaunchAgent/systemd 重定向日志
├── secret.key                    # 团队密钥加密用的本机主密钥
├── team-secrets/<team_id>.enc    # 各团队加密后的密钥包
├── history/<agent_id>.bin        # 本机事件历史（按 agent）
├── teamclaw/sessions.toml        # TeamClaw 会话元数据本地缓存
├── mcp-configs/<id>.json         # 网关会话临时 MCP 配置
├── teams/<team_id>/              # 每团队一份共享内容 + 默认工作区
│   ├── teamclaw-team/            # skills / knowledge / .mcp / _secrets …
│   ├── workspace/                # 无项目路径时的默认 worktree
│   └── sync/state.json           # OSS 同步状态
├── apps/<appId>/                 # Apps 模块检出目录（若使用）
├── pi-sessions/ …                # 【可选】pi runtime 会话数据
└── pi/ …                         # 【可选】pi 扩展等
```

---

## 文件 / 目录详解

每一项：**作用** + **通俗一句话**。

### 1. 可执行文件

| 路径 | 作用 | 通俗一句话 |
|------|------|------------|
| （包内 sidecar） | 桌面直接 spawn App bundle / `apps/desktop/binaries` 里的 `amuxd`，**不**再拷到 `bin/` | **真正在跑的小助手程序（跟桌面同生共死）** |
| `bin/amuxd` | 【遗留】旧版拷贝；托管模式下可忽略 | **旧版残留程序** |
| `bin/teamclaw-introspect` | 【遗留】旧版拷贝；现行 introspect 也是包内 sidecar | **旧版残留探查工具** |

---

### 2. 身份与配置（`amuxd clear` 会删）

| 路径 | 作用 | 通俗一句话 |
|------|------|------------|
| `daemon.toml` | 本机 actor 名/id、MQTT、agents、channels、`team_id`、HTTP 等配置 | **这台机器上小助手的户口本（属于哪个团队）** |
| `backend.toml` | Cloud API 地址、`refresh_token`、`actor_id`、`team_id`；token 轮换会写回 | **小助手登录云端的钥匙** |
| `members.toml` | 本地成员与 pending invite 缓存（历史协作/邀请流程用） | **本机记过的成员/邀请便签** |
| `sessions.toml` | 本机 runtime 索引：`runtime_id`、`acp_session_id`（opencode session）、对应云端 `session_id`、worktree、状态。用于重启后尽量接着同一 agent 上下文；主 resume 路径也可走云端 `agent_runtimes` | **「上次跟哪个 AI 会话连着」的通讯录，不是聊天正文** |
| `workspaces.toml` | **遗留文件**。工作区真相源已改为云端 `amux.workspaces`；`clear` 仍会删它以防复活 | **过期的本地工作区名单（现在一般不用了）** |

> `amuxd clear` / 桌面「Reset and re-initialize」会删上面这 5 个文件（并同时清 legacy 目录里的同名副本，见文末）。**不会**删 `bin/`、日志、团队共享目录、密钥文件等。

---

### 3. 进程与本机通信（运行时生成）

| 路径 | 作用 | 通俗一句话 |
|------|------|------------|
| `amuxd.pid` | 当前 daemon 进程号；桌面用它判断是否在跑、等 stop 完成 | **「小助手还活着吗」的门牌号** |
| `amuxd.lock` | 单实例锁；防止两个 amuxd 同时写配置 | **一次只许一个小助手值班的门锁** |
| `amuxd.sock` | Unix 控制套接字（Windows 用命名管道）；CLI / MCP / 部分控制命令走这里 | **跟小助手说悄悄话的对讲机** |
| `amuxd.http.port` | 本机 HTTP 控制面实际端口（常为 ephemeral） | **告诉桌面：小助手开在几号窗口** |
| `amuxd.http.token` | 本机 HTTP root bearer（权限通常 `0600`） | **桌面敲本机 API 的通行证** |
| `amuxd.cloud-token` | 周期性刷新的 cloud access JWT 文件；注入给长跑 agent（`TC_ACCESS_TOKEN_FILE`） | **给 AI 子进程随时刷新的云端临时工牌** |
| `amuxd.managed.log` | 桌面托管 spawn 时重定向的 stdout/stderr（排障首选） | **小助手的现行工作日记** |
| `amuxd.out.log` / `amuxd.err.log` | 【遗留】旧 LaunchAgent / systemd 重定向 | **旧版后台服务日记** |

---

### 4. 密钥（不在 `clear` 列表里）

| 路径 | 作用 | 通俗一句话 |
|------|------|------------|
| `secret.key` | 32 字节本机主密钥，用来加解密 `team-secrets/` | **保险柜的总钥匙** |
| `team-secrets/<team_id>.enc` | 每团队加密包：team secret、可选 git 凭证等。故意不放在 `teams/<id>/` 下，避免被 git sync 推上云 | **各团队保险箱里的密码本（加密存放）** |

---

### 5. 本地缓存 / 运行时数据

| 路径 | 作用 | 通俗一句话 |
|------|------|------------|
| `history/<agent_id>.bin` | 按 agent 追加写的 protobuf 事件历史，供本机回放/排障 | **本机录下来的事件黑匣子** |
| `teamclaw/sessions.toml` | TeamClaw 会话元数据的本机缓存（标题、参与者等）；**不是** `clear` 删除项 | **会话名片的本地复印件** |
| `mcp-configs/<session>.json` | 网关会话临时 MCP 配置，指向 amuxd 自己的 `mcp-server` 子命令 | **某次聊天临时接上的工具插件清单** |

---

### 6. 团队共享内容 `teams/<team_id>/`

| 路径 | 作用 | 通俗一句话 |
|------|------|------------|
| `teams/<team_id>/teamclaw-team/` | **每团队唯一**的共享副本：`skills/`、`knowledge/`、`.mcp/`、`_secrets/`、`_meta/`、`_feedback/` 等；各工作区通过 `teamclaw-team` 符号链接指向这里 | **团队公共文件夹（全队共用这一份）** |
| `teams/<team_id>/workspace/` | 没有用户项目路径时的默认可写 worktree（例如嵌入式 UI / 无 workspace 的 spawn） | **没指定项目时，小助手默认干活的空桌子** |
| `teams/<team_id>/sync/state.json` | OSS（或相关）同步引擎的本地状态 | **团队文件同步进度条/记账本** |

---

### 7. 其它可选目录

| 路径 | 作用 | 通俗一句话 |
|------|------|------------|
| `apps/<appId>/` | Apps 模块：应用仓库检出、构建工作目录 | **在小助手家里搭的小应用工位** |
| `pi-sessions/`、`pi/` | 仅当构建/配置走 **pi** runtime 时使用（会话与扩展） | **换用 pi 引擎时的专用抽屉** |

---

## 不在 `~/.amuxd` 里、但常一起出现的东西

| 路径 | 说明 | 通俗一句话 |
|------|------|------------|
| `~/.opencode/bin/opencode` | 官方 OpenCode 二进制（由 `amuxd install-opencode` 安装） | **真正跑大模型对话的引擎，住在隔壁** |
| macOS `~/Library/LaunchAgents/cc.ucar.amuxd.plist` | 【遗留】旧开机自启；托管模式启动时会卸载，若仍在则拒绝托管启动 | **旧版「开机自动上班」闹钟** |
| Linux `~/.config/systemd/user/amuxd.service` | 同上 | 同上 |
| Windows 计划任务 `amuxd` | 同上 | 同上 |
| Legacy：`~/Library/Application Support/amux/`（或其它平台 `config_dir/amux/`） | 旧版配置目录；`DaemonConfig` 会把缺的文件迁回 `~/.amuxd`；`clear` 也会清这里的同名文件 | **旧房子里的户口本，不清干净会搬回来** |

---

## 和「切团队 / clear」的关系（易混点）

| 你以为丢了什么 | 实际 |
|----------------|------|
| 聊天列表、消息正文 | **一般在云端**，切回原团队还能从 Cloud API 拉回来 |
| `sessions.toml` | 丢的是**本机 runtime ↔ opencode session 的通讯录**；接续上下文会变难，尤其若重新 onboard 成了**新 agent** |
| `teams/<旧团队>/…` | **`clear` 默认不删**；团队共享文件还在磁盘上 |
| `bin/amuxd` | **不删**（若仍在也只是残留）；程序本体在 App sidecar |

`amuxd clear` 明确删除的仅是：

`daemon.toml`、`backend.toml`、`members.toml`、`sessions.toml`、`workspaces.toml`  
（当前目录 + legacy 目录各一份）

并且：若 daemon **仍在跑**（占着 `amuxd.lock`），`clear` 会拒绝删身份文件，避免旧进程把凭证又写回去。

---

## 相关代码入口

| 主题 | 位置 |
|------|------|
| 配置目录 / pid / sock / http 路径 | `apps/daemon/src/config/daemon_config.rs` |
| `clear` 删除列表 | `apps/daemon/src/cli/clear.rs` |
| 团队全局目录布局 | `apps/daemon/src/config/global_team_store.rs` |
| 团队密钥布局 | `apps/daemon/src/sync/secret_store.rs` |
| Runtime 会话索引 | `apps/daemon/src/config/session_store.rs` |
| 桌面托管 amuxd 生命周期 | `apps/desktop/src/commands/amuxd_supervisor.rs` |
| 首次向导启动 managed amuxd | `apps/desktop/src/commands/setup.rs` |

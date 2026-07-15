# 桌面端首个内测版本 — 核心测试用例设计(60 条)

- **日期**: 2026-06-02
- **范围**: 桌面 App (Tauri, `packages/app` + `apps/desktop`) 为主,amuxd 守护进程 (`apps/daemon`) 与 FC 云端 API (`services/fc`) 作为桌面端依赖的后端链路
- **平台**: macOS(现有自动化基线)+ **Windows**(兼容性套件 W,首版手动,自动化需先改造 harness 传输层)。
- **第一交付范围**: **单人 + 单 agent**。包含单人的 **git/oss 工作区文件同步** 与 **owner 级 team LLM provider 设置**;不涉及多人协作(成员邀请/加入、成员管理)、多 agent 聊天。
- **目标**: **桌面端先跑通** —— 一条 `登录 → 建会话 → 发消息收到流式回复 → 权限/编辑` 的单人端到端主链路必须全绿
- **交付**: 本清单文档 + 适合自动化部分的测试代码(复用现有 tauri-mcp e2e / v2-e2e / FC vitest / daemon cargo)
- **现有自动化已覆盖(勿重复造)**: `tests/v2-e2e/pr/conversation-critical-path.test.ts`(V2-PR-01..04)已确定性覆盖 **C1/C2**(会话列表+排序)、**C3**(切换保持各自历史)、**D2**(发送→流式生命周期)、**D4**(工具 calling→completed→failed)、**D7**(agent error surface)。FC `services/fc/test/auth-pg.test.ts` 已覆盖 **B1 后端**(emailOTP signInOtp→capture→verifyOtp 全程)。自动化新增工作应只补**缺口**:D3/D5/D6/D8/D9/D10、权限 approve/deny 交互(E2)、C4/C5、A4 等。

## 模型/账号前提(影响用例设计)

- 内测**预置共享 LiteLLM key**,用户**无需自己 OAuth 接 provider** → Provider OAuth 套件本版**不纳入**。
- 共享 key 走额度 → 新增"额度/key 失效报错"用例(L5)。
- **第一交付只验单人 + 单 agent** → 多人成员邀请/加入、成员管理、daemon team-link **本版不纳入**;但 **git/oss 工作区同步(H)** 与 **owner 设置 team LLM provider(L6)** 纳入(单人即自身团队 owner)。

## 图例

**优先级**:**P0** 主链路,失败则内测无法进行,放包前必须全绿 / **P1** 高价值,允许已知缺陷但需记录 / **P2** 锦上添花,可延后。

**类型**:**自动** 可被 tauri-mcp / v2-e2e / FC vitest / daemon cargo 确定性驱动;**手动** 需真实网络 / 真实企微扫码 / 真实 LLM 流式质量 / 装机副作用 / 视觉判断。

**自动化框架映射**

| 层 | 框架 | 入口 |
|---|---|---|
| 桌面 UI | tauri-mcp + vitest | `tests/e2e/`、`tests/functional/`(`pnpm test:e2e:legacy`) |
| 跨 daemon 链路 | v2-e2e (`v2Call()` RPC) | `tests/v2-e2e/pr`(`pnpm test:smoke`) |
| 登录/账号/AI 网关后端 | FC vitest | `services/fc/test/`(`cd services/fc && pnpm test`) |
| daemon 行为 | cargo | `apps/daemon/tests/`(`pnpm daemon:test`) |
| 前端 store/组件单测 | vitest | `packages/app/src/**/__tests__/`(`pnpm test:unit`) |

**自动化前置环境**:桌面 e2e 需先 `pnpm tauri:build:debug`(产出 `.cargo-target/debug/teamclaw`,debug 构建才带 tauri-plugin-mcp);桌面 e2e 默认 stub 后端;**登录自动化(B 套件)需 FC `BACKEND_KIND=postgres` + 测试库**(从 Better-Auth `verification` 表读 OTP);全链路用例需本地起 daemon + FC。

## 套件与数量分配(共 60)

| # | 套件 | 用例数 | 优先级 | 自动/手动 |
|---|------|:---:|:---:|---|
| A | 启动与初始化 | 4 | P0 | 4 自动 |
| B | 认证登录 (FC 链路) | 5 | P0 | 5 自动 |
| C | 会话管理 | 5 | P0 | 5 自动 |
| D | 聊天核心链路(流式) | 10 | P0 | 6 自 / 3 手 + 1 性能(自+手) |
| E | 权限审批 | 3 | P0 | 3 自动 |
| F | 文件编辑 & Diff | 6 | P1 | 6 自动 |
| H | 团队文件同步 git/oss(单人) | 4 | P1 | 1 自 / 3 手 |
| I | Daemon 安装 & 链路(单 agent) | 5 | P0/P1 | 3 自 / 2 手 |
| K | 定时任务 Cron | 1 | P2 | 1 自动 |
| L | 设置 & 系统集成 | 6 | P1/P2 | 5 自 / 1 手 |
| M | 企微 Channel(单人) | 4 | P1 | 2 自 / 2 手 |
| W | Windows 兼容性(平台分叉点) | 7 | P0–P2 | 1 自 / 6 手 |
| | **合计** | **60** | | **~43 自 / ~17 手(含 1 性能/耐久)** |

> 已砍:RAG/知识(用户确认不需要)、Provider OAuth(预置共享 key)、**B 团队邀请加入 + daemon team-link**(多人语义)。
> H 套件收窄为**单人 git/oss 工作区同步**(不含成员管理),owner 级 team LLM provider 见 L6。

---

## A. 启动与初始化(4,P0)

| 编号 | 标题 | 前置 | 步骤 | 预期 | 类型 | 对应/框架 |
|---|---|---|---|---|---|---|
| A1 | 冷启动到三栏布局渲染完成 | 已选 workspace | 启动 app | 主窗口出现,左/中/右三栏渲染,无白屏/报错 | 自动 | `tests/e2e/smoke-app-launch.test.ts`(扩展) |
| A2 | 首次启动 workspace 选择/创建向导 | 全新无 workspace | 启动 → 走向导选/建 workspace | 向导出现,选定后进入主界面 | 自动 | `tests/e2e/smoke-workspace-prompt.test.ts` |
| A3 | 通知权限 + 遥测同意弹窗 | 首次启动 | 处理通知权限请求与遥测同意弹窗 | 弹窗按序出现,选择被持久化,不重复弹 | 自动 | `tests/functional/telemetry-consent.test.ts` |
| A4 | 重启后恢复布局/激活会话 | 已有会话与布局 | 关闭后重开 app | 恢复上次激活会话与三栏宽度,无错位 | 自动 | 新增(v2-e2e) |

## B. 认证登录(5,P0,全自动)

| 编号 | 标题 | 前置 | 步骤 | 预期 | 类型 | 对应/框架 |
|---|---|---|---|---|---|---|
| B1 | 邮箱 OTP 登录成功 | FC postgres + 测试库 | tauri-mcp 输入邮箱 → 从 `verification` 表读 6 位 OTP(或测试态覆写 `sendVerificationOTP` 捕获)→ 回填验证 | 登录成功进入主界面,token 写入 | 自动 | `services/fc/src/auth/{better-auth,otp-delivery}.ts` + tauri-mcp |
| B2 | 匿名登录进入 | — | 选择匿名登录 | 进入主界面,生成匿名身份 | 自动 | `tests/e2e`(新增) |
| B3 | 错误/过期 OTP 报错提示 | — | 输入错误/过期 OTP | UI 显示明确错误,不进入主界面,可重试 | 自动 | FC test(invalid/501)+ UI |
| B4 | 登出后重新登录 + token 持久化 | 已登录 | 登出 → 重启 → 重新登录 | 登出清态,重登恢复,token 跨重启持久 | 自动 | `tests/e2e`(新增) |
| B5 | access token 过期自动刷新(不登出) | 已登录,持有 refresh token | 令 access token(JWT)过期 → 发任意需鉴权请求 | 401 时自动调 `POST /v1/auth/refresh` 换新 token 并重试,**用户保持登录不被注销**;仅当 refresh token 亦失效时才优雅登出 | 自动 | `services/fc/src/lib/routes/auth.ts`(`/v1/auth/refresh`)、`cloud-api/http.ts`(401 刷新重试) |

## C. 会话管理(5,P0,全自动)

| 编号 | 标题 | 前置 | 步骤 | 预期 | 类型 | 对应/框架 |
|---|---|---|---|---|---|---|
| C1 | 新建会话并出现在列表 | 已登录 | 点"新建会话" | 新会话创建并置顶,自动激活 | 自动 | `tests/e2e/session-management.e2e.test.ts` |
| C2 | 会话列表排序(最近活跃置顶) | ≥2 会话 | 在某会话发消息 | 该会话排到列表顶部 | 自动 | session-list store |
| C3 | 切换激活会话内容正确 | ≥2 会话 | 点击不同会话 | 中栏切换到对应内容,无串内容 | 自动 | session-selection store |
| C4 | Spotlight 搜索并切换会话 | ≥2 会话 | 唤起 spotlight → 搜索 → 回车 | 命中并切换到目标会话 | 自动 | `tests/e2e/spotlight-main-switch.test.ts` |
| C5 | 删除/归档会话 | 有会话 | 删除/归档某会话 | 从列表移除,激活态合理回退 | 自动 | 新增 |

## D. 聊天核心链路(10,P0)— 桌面端跑通的心脏(单 agent)

| 编号 | 标题 | 前置 | 步骤 | 预期 | 类型 | 对应/框架 |
|---|---|---|---|---|---|---|
| D1 | **预置 key 开箱即用** | 全新用户,预置共享 key,零配置 | 新建会话 → 发第一条消息 | **无需任何 provider 配置即收到模型流式回复**(跑通金标准) | 手动(真实网关) | 全链路 |
| D2 | 发送消息 → 流式增量渲染 | 已可发消息 | 发一条消息 | 回复按 delta 增量出现,`streamingContent` 平滑更新 | 自动 | v2-e2e |
| D3 | 流式中打断/取消 | 正在流式 | 流式途中点中断 | 立即停止,ACP cancel 生效,UI 状态归位 | 自动 | 参考 PR #284(interrupt bar / ACP cancel) |
| D4 | 多 part 消息渲染顺序 | agent 含工具调用/思考块 | 触发工具调用类回复 | parts 按序渲染(文本/工具/思考),无错位 | 手动(视觉) | — |
| D5 | 消息历史持久化 + 重启恢复 | 有历史消息 | 重启 app → 打开该会话 | 历史完整恢复,顺序正确,无丢失/重复 | 自动 | v2-e2e |
| D6 | 连续发送 / 排队消息 | — | 快速连发多条 | 按序处理,无并发错乱,无丢消息 | 自动 | v2-e2e |
| D7 | agent 失败/网络错误提示 | mock 失败 | 制造后端/网络失败 | UI 显示明确错误,可重试,不卡死 | 自动 | mock 注入 |
| D8 | 流式→完成切换无跳变 | — | 观察流式结束瞬间 | 从 `streamingContent` 切到 `message.parts[]` 无内容跳变/重复(单一数据源原则) | 手动(视觉回归) | CLAUDE.md 流式架构铁律 |
| D9 | 长回复自动滚动到底 | — | 触发长回复 | 内容滚动跟随到底;用户上滚时不强制拉回 | 自动 | 新增 |
| D10 | **长会话持续流式稳定性(性能/耐久)** | 大量历史消息 / 超长单条流式回复 | 注入数千 delta 的长流(mock)+ 真实长会话 soak | 全程不掉帧/不卡死、内存不持续增长(无泄漏)、delta 不丢不乱序、`streamingContent`→`parts[]` 切换在规模下仍正确 | 自动(mock 长流量化:内存/帧率/延迟)+ 手动(真实 soak) | `tests/performance/ux-responsiveness.test.ts`(扩展) |

## E. 权限审批(3,P0,全自动)

| 编号 | 标题 | 前置 | 步骤 | 预期 | 类型 | 对应/框架 |
|---|---|---|---|---|---|---|
| E1 | 工具触发权限弹窗 → 允许一次 | agent 触发文件读写 | 弹窗 → "允许一次" | 工具执行,下次仍弹窗 | 自动 | `tests/e2e/permission-flow.e2e.test.ts` |
| E2 | 总是允许 / 拒绝 分支 | 同上 | 分别选"总是允许"/"拒绝" | 总是允许后免弹;拒绝则工具不执行并提示 | 自动 | `tests/functional/permission-actions.test.ts` |
| E3 | 权限审批 bar + 通知 | 后台会话触发 | 观察审批 bar 与系统通知 | bar 显示待审批,通知正确,点击可跳转 | 自动 | `tests/e2e/permission-notification.test.ts` |

## F. 文件编辑 & Diff(6,P1,全自动)

> markdown 与 code 均为同一 **CodeMirror 6** 控件(Tiptap 已弃用),不单列 markdown 用例。

| 编号 | 标题 | 前置 | 步骤 | 预期 | 类型 | 对应/框架 |
|---|---|---|---|---|---|---|
| F1 | 文件树浏览/展开/折叠 | 有 workspace 文件 | 展开/折叠目录 | 树正确渲染,无错乱 | 自动 | `tests/functional/workspace-filetree.test.ts` |
| F2 | 编辑文件(CodeMirror,含 .md / 代码)高亮 | 打开代码或 .md | 编辑并保存 | CodeMirror 编辑正常、`lang-markdown`/语法高亮正确,保存落盘 | 自动 | `tests/functional/file-editor.test.ts`、`MarkdownEditor.tsx` |
| F3 | HTML 预览沙箱渲染 | 打开 .html | 切到预览(`supportsPreview==='html'`) | 沙箱内正确渲染,无脚本逃逸 | 自动 | `FileEditor.tsx`(showPreview/previewType)、`WebViewContent.tsx`、`FileEditor.test.tsx` |
| F4 | Diff 视图 + 接受/拒绝 change | 有 diff | 查看 diff → 接受/拒绝 | diff 渲染正确,接受/拒绝按预期落盘 | 自动 | `tests/e2e/file-editor-diff.test.ts`、`tests/functional/diff-renderer.test.ts` |
| F5 | 未保存改动切换文件的保护 | 文件有未保存改动 | 切换到另一文件 | 提示保存/丢弃,数据不静默丢失 | 自动 | 新增 |
| F6 | 大文件 / 二进制文件打开行为 | 有大文件/二进制 | 打开 | 大文件不卡死(降级/分页),二进制有合理提示 | 自动 | 新增 |

## H. 团队文件同步 git/oss(4,P1)— 单人:工作区文件跨端同步,不含多人成员管理

> 同步由**桌面 Tauri 后端**驱动(`commands/team_share/` + `custom_git.rs`)。daemon 自带的 per-team git 同步(`team_shared_git::sync_git_dir`)是另一条独立路径,其架构合理性**另案处理,不在本 spec 范围**。

| 编号 | 标题 | 前置 | 步骤 | 预期 | 类型 | 对应/框架 |
|---|---|---|---|---|---|---|
| H1 | 启用 share 并锁定同步模式(git / oss) | 已有团队/workspace | 走启用向导锁定 `git` 或 `oss` 模式 | 模式一次性锁定,重复锁返回 409;`workspace-config` 反映正确 | 自动 | `tests/e2e/smoke-team-share-onboarding.test.ts`、FC `/v1/teams/:id/share-mode` |
| H2 | git 同步:推送/拉取工作区文件 | 已锁 git 模式 | 本地改文件 → 推送;远端改 → 拉取 | 双向同步成功,两端文件一致,提交历史正确 | 手动(真实 git remote) | managed_git / custom_git |
| H3 | OSS/WebDAV 同步:状态 + 手动同步 | 已锁 oss 模式 | 触发同步 → 看状态卡 | 状态正确流转(同步中/完成/失败),文件实际落 OSS | 手动(真实 OSS) | `TeamOssSyncStatus.tsx` |
| H4 | 本地改动与远端分叉时的同步处理 | 本地与远端(另一设备/直接改 remote)各改同一文件 | 在桌面触发同步(push/pull) | 冲突被检测并提示,不静默覆盖丢数据 | 手动 | `team_share/custom_git.rs` |

## I. Daemon 安装 & 链路(5,P0/P1)— 单 agent 本地链路

| 编号 | 标题 | 前置 | 步骤 | 预期 | 类型 | 对应/框架 |
|---|---|---|---|---|---|---|
| I1 | 安装本地 daemon | 未装 | 触发安装(`install_local_daemon`) | 安装成功或失败有明确反馈,不静默"假装已装" | 手动(装机副作用) | `daemon_installer.rs` |
| I2 | daemon 可用性/状态显示 | — | 查看 daemon 状态区 | 在线/离线状态准确,断开有提示 | 自动(mock daemon HTTP) | `DaemonGeneralSection.tsx` |
| I3 | 单 agent 走本地 runtime 跑通一条消息 | daemon 已起 | 选本地 daemon runtime → 发消息 | agent 经本地 daemon 处理并流式回复 | 自动 | v2-e2e daemon 链路 |
| I4 | workspace 注册/列表同步 | daemon 已起 | daemon 注册 workspace | 桌面 workspace 列表与 daemon 一致 | 自动 | v2-e2e daemon 链路 |
| I5 | 预置 key 下模型目录可选可用 | daemon 已起 | 选 daemon / cloud 模型发消息 | 模型目录正确,选定模型实际可用,缺失不静默失败 | 手动 | 参考 commit `5e98a945` |

## K. 定时任务 Cron(1,P2)

| 编号 | 标题 | 前置 | 步骤 | 预期 | 类型 | 对应/框架 |
|---|---|---|---|---|---|---|
| K1 | 创建 cron job + 历史/启停 | 已登录 | 建定时任务 → 启停 → 看历史 | 任务创建,启停生效,历史可见 | 自动 | `packages/app/src/stores/__tests__/cron.test.ts`(扩展) |

## L. 设置 & 系统集成(6,P1/P2)

| 编号 | 标题 | 前置 | 步骤 | 预期 | 类型 | 对应/框架 |
|---|---|---|---|---|---|---|
| L1 | 语言切换 i18n | — | 切 zh-CN / en | 文案整体切换,无漏翻/串码 | 自动 | `tests/e2e/smoke-i18n.test.ts` |
| L2 | Tray/Dock 钉选会话 | 有会话 | 钉选会话到 tray/dock | 钉选项出现,点击可唤起对应会话 | 自动 | `tests/regression/tray-spotlight-pin.test.ts`、`macos-dock-tray.test.ts` |
| L3 | 自动更新检查 | — | 触发更新检查 | 正确返回有/无更新,流程不报错 | 自动 | `tests/e2e/auto-update.test.ts` |
| L4 | AI 网关用量/额度 + key 失效报错 | 预置共享 key | 查看用量;模拟超额/失效后发消息 | 用量/额度正确显示;超额/失效时报错明确而非静默卡死 | 手动 | FC `/ai/usage`、`/ai/budget`、`/ai/keys` |
| L5 | API key / 运行时切换(本地 daemon vs 云端) | — | 在设置切换运行时/填 API key | 切换生效,后续会话走对应运行时,配置持久 | 自动 | `DaemonGeneralSection.tsx` |
| L6 | 团队 owner 设置统一 team LLM provider | owner 身份 | 在设置选定/切换 team LLM provider → 保存 | LiteLLM 按团队 provision,返回 `aiGatewayEndpoint`+key;全团队后续会话走该 provider;FC 未配置时 503 `litellm_unavailable` | 自动(FC 契约)/ 手动(真实 provision) | FC `/v1/teams/:id/litellm/setup`、`/ai/setup-team`、`/ai/keys` |

## M. 企微 Channel(4,P1)— 单人:用户经企微与自己的 agent 对话

| 编号 | 标题 | 前置 | 步骤 | 预期 | 类型 | 对应/框架 |
|---|---|---|---|---|---|---|
| M1 | 向导手动填 botId/secret → 保存 | 进入企微设置 | 选"手动" → 填 botId/secret → 完成 | 配置经 `save_channel_config('wecom')` 落盘,向导关闭 | 自动 | 扩展 `channels/__tests__/Wecom.test.tsx` 至 e2e |
| M2 | QR 扫码绑定 | 进入企微设置 | 选"扫码" → 拉 QR(`startWecomQrAuth`)→ 企微扫 → 轮询(`pollWecomQrAuth`)回填凭证 | 扫码后自动回填 botId/secret,超时有提示 | 手动(真实企微扫码) | `stores/channels/wecom.ts`、`gateway/qr.rs` |
| M3 | 启用网关→状态流转 | 已存配置 | 启用 → 看状态 → 停用 | 启用后 connecting→connected,停用后 disconnected | 自动(mock `list_channels`) | `stores/channels/wecom.ts`(`startWecomGateway`/`stopWecomGateway`/`refreshWecomStatus`) |
| M4 | 端到端:企微收发 | 网关已连接 + daemon | 企微里给 bot 发消息 → agent 处理 → 回复 | 企微消息路由到 agent,agent 回复回到企微对话 | 手动(真实企微 + daemon 长连接) | amuxd 网关 + `amuxd-channels.ts` |

---

## W. Windows 兼容性(7,P0–P2)— 平台分叉点,首版以手动为主

> **Infra 前置**:tauri-mcp 走 Unix domain socket(`tests/_utils/tauri-mcp-test-utils.ts`,默认 `/tmp/tauri-mcp.sock`),**Windows 无法直接驱动**。要自动化 Windows e2e 需先把传输层改成 named pipe / TCP(测试 util + `tauri-plugin-mcp` 两端),并加 Windows CI runner(当前仅 `release.yml` 在 Windows 打包,无测试)。在此之前 W 套件以**手动**执行。
> **矩阵建议**:harness 支持 Windows 后,A/C/E/F 等纯 UI 自动套件应在 Windows 矩阵复跑;W 只覆盖平台**差异点**。

| 编号 | 标题 | 前置 | 步骤 | 预期 | 类型 | 对应/框架 |
|---|---|---|---|---|---|---|
| W1 | 安装包(NSIS/MSI)安装 + WebView2 + 首启 | 干净 Windows | 安装 → 首次启动 | 安装成功,WebView2 运行时存在/自动引导安装,冷启动到三栏无白屏 | 手动 | bundle targets=all、`webview.rs` |
| W2 | 核心主链路 Windows 跑通(smoke) | 已安装 | 登录 → 建会话 → 发消息收流式回复 → 权限审批 | 主链路与 macOS 行为一致,无平台特异性崩溃 | 手动 | 对应 A/B/D/E 在 Windows |
| W3 | 文件路径处理(反斜杠/盘符/长路径) | 有 workspace | 在含空格/中文/盘符路径下浏览、编辑、保存、diff | 路径正确解析,无转义/分隔符错误,保存落对位置 | 自动(path util 单测)+ 手动(e2e) | `process_util.rs`、editors path util |
| W4 | 快捷键 Ctrl 映射 | — | spotlight、发送、各快捷键 | Windows 用 Ctrl(而非 Cmd),无冲突/失效 | 手动 | shortcuts |
| W5 | Tray / 系统通知 Windows 行为 | 有会话 | 托盘菜单、钉选、通知 | 系统托盘与通知在 Windows 正常(对照 macOS dock/tray) | 手动 | 对照 `tests/regression/macos-dock-tray.test.ts` |
| W6 | 终端 ConPTY + agent/opencode 进程 spawn | daemon/runtime 就绪 | 开终端跑命令;触发本地 agent/opencode | ConPTY 起 shell、输出流式;`cfg(windows)` 进程分支正确 spawn 并通信 | 手动 | `terminal.rs`、`opencode.rs`(9 处 cfg windows)、daemon `supervisor.rs` |
| W7 | 自动更新(NSIS/MSI) | 已安装旧版 | 触发更新 | Windows 更新包正确下载/安装/重启,不损坏安装 | 手动 | `updater.rs` |

## 自动化落地优先级(出代码顺序)

1. **P0 主链路自动化先行**:A(4)、B(5,含 OTP 自动取码 + 401 刷新重试)、C(5)、E(3)、D2/D5/D6/D7/D9(5) —— 确定性最高、复用现有 e2e 框架,先建"跑通"护栏。
2. **v2-e2e 扩链路(单 agent)**:A4、D2/D5/D6、I3/I4 —— v2Call RPC 已支持 daemon 链路,优先在此补全单 agent 本地链路自动化。
3. **后端单元**:B1/B3(FC postgres + verification 表)、K1(store)、M1/M3(channels store/组件)。
4. **手动脚本成册**:D1/D4/D8、I1/I5、M2/M4、L5 —— 写成内测人员可照走的手动 checklist。

## 已知不做(本版第一交付)

- 知识/RAG(用户确认不需要)
- Provider OAuth(预置共享 key,用户不自行授权)
- **多人协作 / 团队成员邀请加入 / 成员管理 / daemon team-link**(只看单人 + 单 agent;git/oss 单人工作区同步见 H,owner 设 team LLM provider 见 L6,均纳入)
- **多 agent 聊天**(只看单 agent)
- iOS / Expo 客户端(本版仅桌面链路)

## 放包门槛建议

- **必须全绿**:全部 P0(A、B、C、D、E、以及 I 中 P0 项 I3)。
- **允许带已知缺陷但需记录**:P1。
- **可延后**:P2(K)。

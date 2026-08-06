# 运行时功能开关：把一部分 build config 搬到 Cloud API — Implementation Plan

> **For agentic workers:** Steps use checkbox (`- [ ]`) syntax for tracking. 按 Task 顺序执行，每个 Task 自带验证命令。

**Goal:** 让 `features.auth.*`、`features.channels.*`、`features.teamShareBrowser`、`features.apps` 这几个开关可以由 Cloud API 在运行时下发，改开关不再需要重新打包客户端；`build.config*.json` 退化为默认值（离线 / 首次启动 / 远端不可达时的地板），而不是唯一真相。

**Architecture:** 每个 key 有且只有一个权威端点，不冗余：

- `GET /v1/config/public`（无 auth，登录屏用）→ `webSso`、`features.auth.*`
- `GET /v1/config/bootstrap`（Bearer，登录后用）→ `mqtt`、`features.{channels,teamShareBrowser,apps}`
- `GET /v1/teams/:teamId/workspace-config`（已存在，团队维度）→ `lockLlmConfig`

服务端值**以入库文件为主、env 为辅**（见下节「两个部署环境」）：`services/fc/features/<profile>.json` 随代码打包，`APP_FEATURES_PROFILE` 选用哪份，`APP_FEATURES_JSON` 作为临时覆盖。只引入这两个 env 变量，避免每加一个开关都要在 `s.yaml` 和 compose 两处各声明一次。客户端新增 `packages/app/src/lib/remote-features.ts`：同步读 localStorage 快照 → 首帧可用，后台刷新 → zustand 通知重渲染；合并语义 `deepMerge(buildConfig.features, remote)`，唯一例外是 `webSSO` 走 `build && remote`。

**Tech Stack:** FC (Node 20 / TypeScript, `services/fc/src/lib/routes/config.ts`, `node --test`)、React 19 + zustand、Vitest。

**Spec:** 本文件即设计文档，无独立 spec。

---

## 两个部署环境，两套独立配置

有两个在跑的 Cloud API，品牌不同、数据库不同、部署方式不同，**没有共享的真相源**——两边各配各的，这也正是想要的（belayo 可以开跟公开版不同的登录方式）。

| | self-host | belayo |
|---|---|---|
| 地址 | `api.teamclaw-dev.ucar.cc`（ECS 47.112.210.217） | `teamclaw-api.ucar.cc`（Alibaba FC） |
| 部署 | push 到 main 命中 `services/fc/**` 自动触发 | `deploy-aliyun-fc.sh` 手工，有交互确认 |
| env 来源 | 那台机器上的 `.env`，**跨部署持久** | 操作者本机的 `.env.*.local` → `s.yaml` 的 `${env(...)}` |
| 部署后校验 | `self-host-deploy.yml` 跑 `run-e2e.sh` | 无 CI 门禁，只能手工 curl |

**belayo 的 env 是每次部署整体覆写的。** `s deploy` 把整个 function 的 environmentVariables 重写一遍，所以某个变量在这次部署所用的 env 文件里缺失，**不等于「保持现值」，等于「清空」**。

这不是推测：`deploy-aliyun-fc.sh:95-101` 的注释里就记着 `MQTT_BROKER_URL` 因为 `''` 默认值在 belayo 上被抹成空，导致 bootstrap 又一次不带 broker。同一个机制会同样作用于 feature flag，而且后果更重——登录方式一旦靠远端下发，一次常规部署把它抹掉就是**登录按钮消失**，是可用性事故不是外观回归。

**所以 flag 的持久位置是入库文件，不是 env。** feature flag 不含凭证，可以进 git：

```
优先级：APP_FEATURES_JSON（env，临时应急）
      > services/fc/features/<APP_FEATURES_PROFILE>.json（文件，持久、可 review、有 git 历史）
      > 代码内置默认（全部回落 build config）
```

值跟着代码走，belayo 部署抹不掉它。改开关 = 一个 PR：self-host 那边 merge 到 main 自动生效，belayo 那边跟着下次手工部署生效。env 覆盖只留给「现在就要关掉」，并且要记住 **belayo 的 env 覆盖会在下次部署时丢失**。

---

## 不搬的字段，以及为什么

| 字段 | 为什么留在编译期 |
|---|---|
| `app.*`（name / displayName / identifier / scheme / logo / palette） | 打包产物物理绑定，改不了 |
| `cloudApiUrl` | 先有鸡蛋：它就是拿 config 的地址 |
| `extensions.*` | Chrome 扩展打包参数 |
| **`features.updater`** | **唯一「远程关掉就救不回来」的开关**：`updater.ts:6` 关的不只是 UI，还有启动自检。env 里一个笔误会让整个已装机群体失去自更新能力，修复需要用户手动重装 |
| `features.auth.webSSOHosts` | 已被 `apps/desktop/build.rs:155` 烘进 `WEBSSO_ADMIN_HOSTS`，`webview.rs:234` 做原生侧复查。这是「把本地 session 注入某个 webview」的宿主白名单，不能让服务端单方面扩大 |
| `localAgent` | onboarding 时写进 daemon 的 `agents.local_agent`，改远端值对已 onboard 的设备无效，需要单独的迁移故事 |
| `defaults.theme` | index.html 内联脚本首帧使用，远端值最早只能第二次启动生效，收益为零 |

`features.auth.webSSO` 是**搬但用 AND**：`effective = buildConfig.features.auth.webSSO && remote.auth.webSSO`。服务端可以关，不能开——开的前提是那台构建烘了对应的 host 白名单。

远程 flag 只是 UI 门禁，**不是授权**。`apps` 关掉只是藏入口，服务端要继续自己拦（现有 `503 deploy_unavailable` 那套）。

---

## File Structure

**服务端**
- `docs/openapi/teamclaw-api.v1.yaml` — **改**。`BootstrapConfig` / 新增 `PublicConfig` schema；顺手修既有漂移（缺 `webSso`/`tcpUrl`，多了实际不下发的 `username`/`password`）。
- `services/fc/src/lib/routes/config.ts` — **改**。新增 `resolveFeatures()` / `buildPublicFeatures()` / `buildBootstrapFeatures()`；`buildPublicConfig` 不再是 bootstrap 的子集。
- `services/fc/features/self-host.json`、`services/fc/features/belayo.json` — **新建**。入库的 flag 真相源，初始内容 = 各环境当前 build config 的等价值（零行为变更）。
- `services/fc/test/config-route.test.ts` — **改**。补 features 用例。
- `services/fc/s.yaml` + `deploy/self-host/docker-compose.yml` — **改**。各声明一次 `APP_FEATURES_PROFILE` / `APP_FEATURES_JSON`。
- `services/fc/deploy-aliyun-fc.sh` — **改**。preflight banner 打印生效 profile 与解析出的 flag。
- `services/fc/Dockerfile` — **确认**。`features/` 目录必须进镜像（若用了 COPY 白名单）。

**客户端**
- `packages/app/src/lib/remote-features.ts` — **新建**。快照存取 + 合并 + zustand store。
- `packages/app/src/lib/__tests__/remote-features.test.ts` — **新建**。
- `packages/app/src/lib/bootstrap.ts` — **改**。两个 fetch 各自把 `features` 交给 remote-features。
- `packages/app/src/lib/server-config.ts` — **改**。`setCloudApiUrlOverride` 增加 origin 变更通知。
- `packages/app/src/main.tsx` — **改**。启动无条件触发 public 抓取。
- 读取点迁移：`LoginScreen.tsx:19-21,141-142`、`UpgradeAccountDialog.tsx:39`、`web-sso.ts:54`、`ChannelsSection.tsx:14`、`Settings.tsx:145`、`NavRail.tsx:160,178`、`SidebarSecondColumn.tsx:16,18`、`App.tsx:741`。
- `packages/app/src/lib/__tests__/no-direct-feature-read.test.ts` — **新建**。护栏，仿 `no-supabase-import.test.ts`。

---

## Task 1: OpenAPI 契约先行

**Files:** `docs/openapi/teamclaw-api.v1.yaml`

- [ ] **Step 1**：修既有漂移。`BootstrapMqttConfig` 删掉 `username`/`password`（`config.ts:49` 注释写明故意不下发），补 `tcpUrl`。
- [ ] **Step 2**：`BootstrapConfig` 增加 `features`（只含 `channels` / `teamShareBrowser` / `apps`），去掉 `additionalProperties: true` 的兜底心态但保留该字段以便向前兼容。
- [ ] **Step 3**：新增 `PublicConfig` schema 与 `/v1/config/public` 的 path 条目（当前 OpenAPI 里**根本没有这个端点**），含 `webSso` + `features.auth`。
- [ ] **Step 4**：两个端点都加可选 query `brand` / `platform` / `version`，服务端 Phase 1 忽略，为一套 Cloud API 服务多品牌 + 版本门禁留口。

**验证：** `npx @redocly/cli lint docs/openapi/teamclaw-api.v1.yaml`（或仓库现有的 openapi 校验脚本）。

---

## Task 2: FC 端点实现

**Files:** `services/fc/src/lib/routes/config.ts`, `services/fc/test/config-route.test.ts`

- [ ] **Step 1: 先写失败测试**，加到 `config-route.test.ts`（`node --test`，沿用现有 `withEnv` helper）：
  - profile 文件与 `APP_FEATURES_JSON` 都缺失 → 两个端点都不含 `features` 键（沿用 `envValue()` 的 blank-as-absent 语义，`config.ts:19`）。
  - `APP_FEATURES_PROFILE` 指向不存在的文件 → 不抛、不 500，`console.warn` 一次后当作空（部署不能因为拼错 profile 名整个挂掉）。
  - 文件与 env 同时存在 → env 逐键覆盖文件，**不是整块替换**（否则临时关一个开关会把其余全部抹回默认）。
  - 非法 JSON（文件或 env）→ 不抛、不 500，当作缺失，并且 `console.warn` 一次。
  - `{"auth":{"google":true},"channels":{"discord":false}}` → public 只回 `auth`，bootstrap 只回 `channels`，**互不出现**。
  - 未知 key（`{"nope":true}`）→ 被丢弃，不透传。
  - 非布尔值（`{"apps":"yes"}`）→ 该键被丢弃，其余键保留。
  - public 端点在任何情况下都不含 `mqtt`（已有的这条断言要保住）。

- [ ] **Step 2: 实现**。新增：

```ts
// 允许远程覆盖的键，白名单硬编码 —— 服务端能下发什么由代码决定，不由 env 决定。
const PUBLIC_FEATURE_KEYS = ["google", "wechat", "phone", "password", "webSSO"] as const;
const BOOTSTRAP_FEATURE_KEYS = ["teamShareBrowser", "apps"] as const;
const CHANNEL_KEYS = ["discord", "feishu", "email", "kook", "wecom", "wechat"] as const;

// 文件 → env，逐键合并。两处都 try/catch，任何解析失败都退化为「没有覆盖」而不是抛。
function resolveFeatures(): Record<string, any> { /* readProfileFile() ⊕ parseEnvJson() */ }
```

  `updater` 不在任何白名单里，即使有人往 env 里写了也不会下发（Task 2 的测试要覆盖这条）。

- [ ] **Step 3**：`registerConfig` 里两个 handler 各自组装。`ctx.query?.get?.("brand")` 读出来先只记日志，不参与逻辑（对齐 `teams.ts:9` 的既有写法）。

**验证：** `cd services/fc && pnpm test`。

---

## Task 3: 两个部署环境各自落地

**Files:** `services/fc/features/*.json`, `services/fc/s.yaml`, `deploy/self-host/docker-compose.yml`, `services/fc/deploy-aliyun-fc.sh`, `services/fc/Dockerfile`, `docs/deployment/full-backend-stack.md`

- [ ] **Step 1: 建 profile 文件**。`services/fc/features/self-host.json` 与 `features/belayo.json`，初始内容写成**各自环境当前的等价值**（照 `build.config.production.json` 和 belayo 品牌配置抄），这样上线当天行为零变化，后续再逐个动。文件顶部注释写明：这是运行时下发给客户端的开关，改这里要走 PR。

- [ ] **Step 2: 两个部署目标各声明一次**。缺一处就在另一个目标上静默失效——CLAUDE.md 明写的坑。
  - `s.yaml`（`:93` 附近，跟 `WEBSSO_LOGIN_URL` 同块）：
    `APP_FEATURES_PROFILE: ${env('APP_FEATURES_PROFILE', 'belayo')}` / `APP_FEATURES_JSON: ${env('APP_FEATURES_JSON', '')}`
  - `docker-compose.yml`（`:291` 附近）：
    `APP_FEATURES_PROFILE: "${APP_FEATURES_PROFILE:-self-host}"` / `APP_FEATURES_JSON: "${APP_FEATURES_JSON:-}"`

  两边的 **default 值不同且都不为空**——这是有意的。profile 名写死在部署定义里，operator 什么都不做也能拿到正确的那份；env 文件缺失最坏是回落到本环境的 profile，而不是回落到"什么都没有"。

- [ ] **Step 3: 确认 `features/` 进得了镜像和 FC 包**。`Dockerfile` 若用 COPY 白名单要补一条；`s.yaml` 的打包若有 include/exclude 规则同理。**这一步漏了，两个环境都会在运行时读不到文件而静默回落默认值**，且本地测试全绿——因为本地是直接读源码目录。加一条启动日志（`[config] features profile=<name> keys=<n>`）让这种情况在日志里可见。

- [ ] **Step 4: belayo 部署脚本加可见性**。`deploy-aliyun-fc.sh` 的确认 banner（`:139-152`）加两行：

  ```
  echo "  features : profile=${APP_FEATURES_PROFILE:-belayo}"
  echo "  feat-env : ${APP_FEATURES_JSON:+<override present>}${APP_FEATURES_JSON:-<none>}"
  ```

  那个交互确认是 belayo 唯一的部署前检查点。**不做成硬失败**：profile 文件已经保证了 flag 不会被抹掉，env 为空是完全正常的状态，再加一道 `ALLOW_EMPTY_*` 只会训练人无脑按 y。但如果 banner 显示 `<override present>`，operator 要知道这次部署会把它写进 function env 并在下次部署时被覆盖。

- [ ] **Step 5: 文档**。`docs/deployment/full-backend-stack.md` 补一节：两个环境各自改哪个文件、self-host 走 main 自动部署 / belayo 跟下次手工部署、env 覆盖是临时的且 belayo 下次部署会丢。

**验证：**
```bash
docker compose -f deploy/self-host/docker-compose.yml config | grep APP_FEATURES   # 两个变量都在
docker build -t fc-check services/fc && \
  docker run --rm fc-check ls /app/features                                        # 文件进镜像了
```
belayo 侧无法在本地验证打包内容，只能部署后 curl（见验证清单）。

---

## Task 4: 客户端 remote-features 内核

**Files:** `packages/app/src/lib/remote-features.ts`（新建）, `packages/app/src/lib/__tests__/remote-features.test.ts`（新建）

两份快照，都按 cloudApiUrl 的 **origin** 分区：

```
teamclaw.remoteFeatures.public:<origin>    // 登录屏首帧同步读
teamclaw.remoteFeatures.session:<origin>   // 登录后生效
```

分开的理由：退出登录只清 session 那份，public 是部署级配置必须留着——否则下次开 app 登录屏又退回 build config 默认值，重演 #634「退登把地址清了导致下次没得用」。

- [ ] **Step 1: 先写失败测试**：
  - 无快照 → `resolveFeatures()` 全等于 `buildConfig.features`。
  - 远端 `{}` → **不等于全关**，仍回落 build config（#634 的 `cloud-empty` 教训）。
  - 远端给 `channels: {discord:false}` 而 build 是全开 → 只有 discord 关，其余保持（deepMerge 逐键，不整块替换）。
  - build `webSSO:false` + 远端 `webSSO:true` → **false**（AND）；build true + 远端 false → false。
  - 换 origin → 读不到旧 origin 的快照。
  - 写入非法/半截 JSON → 读取不抛，回落 build config。
  - 快照里出现 `updater` → 被忽略（客户端也要有白名单，不能只信服务端）。

- [ ] **Step 2: 实现**。模块级同步初始化（`typeof window === "undefined"` 守卫，跟 `server-config.ts:50` 一致），zustand store 暴露 `useFeatures()` / `useFeature(key)`，非 React 侧用 `getFeatures()`。写入函数 `applyRemoteFeatures(scope, payload)` 做白名单 + 类型校验后落盘并通知。

**验证：** `pnpm test:unit -- remote-features`。

---

## Task 5: 两个触发点

**Files:** `packages/app/src/main.tsx`, `packages/app/src/lib/bootstrap.ts`, `packages/app/src/lib/server-config.ts`, `packages/app/src/lib/auth/web-sso.ts`

- [ ] **Step 1**：`fetchPublicConfig` 改为同时把 `features.auth` 交给 remote-features；`fetchAndApplyBootstrap` 同理交 `features.{channels,teamShareBrowser,apps}`。两者保持 best-effort、永不抛的既有契约。
- [ ] **Step 2**：`main.tsx` 启动无条件 `void fetchPublicConfig()`。**不能挂在 `useAppInit`**——`App` 在 `main.tsx:119` 被包在 `<AuthGate>` 里，登录屏（`AuthGate.tsx:381`）根本走不到那儿。fire-and-forget，不阻塞首帧。
- [ ] **Step 3**：`web-sso.ts:146-152` 那个 on-demand 兜底保留但降级为兜底（注释说明主路径已在启动时）。注意当前是**死循环**：按钮由 `features.auth.webSSO` 控制显隐，而抓 public 的时机在点按钮之后——Step 2 正是解这个。
- [ ] **Step 4**：`setCloudApiUrlOverride` 增加 origin 变更回调，remote-features 订阅后主动重取。今天 `DesktopOnboarding.tsx:243` 的 `applyAndReload` 会 `window.location.reload()`，所以重取「免费」；但那是巧合不是保证——哪天有人加个不重载的服务器切换，这条链就断了。回调把它变成结构性保证。
- [ ] **Step 5**：登录屏首帧闪烁（build 默认值 → 远端值到达后按钮变化）**接受**，只在首次装机/刚换服务器那一次出现。不加 loading 门槛：网络差时那会把用户卡在白屏。

**验证：** `pnpm test:unit`，并手动跑 `pnpm tauri:dev` 确认登录屏按钮随远端值变化。

---

## Task 6: 迁移读取点 + 护栏

**Files:** 上面 File Structure 列的 9 个组件 + `no-direct-feature-read.test.ts`（新建）

- [ ] **Step 1**：逐个把 `buildConfig.features.X` 换成 `useFeature('X')`。**重点是 `ChannelsSection.tsx:14`**——它是模块级 `const`，远端值到了界面也不会变，这类静态求值是本次改造真正的工作量。
- [ ] **Step 2**：护栏测试，仿 `packages/app/src/lib/backend/__tests__/no-supabase-import.test.ts` 的写法：扫 `packages/app/src`，除 `remote-features.ts` 和测试文件外，禁止出现 `buildConfig.features`。
- [ ] **Step 3**：`build-config.ts` 的 `features` 字段加注释指向 remote-features，说明它现在是默认值而非真相。

**验证：** `pnpm typecheck && pnpm lint && pnpm test:unit`。

---

## Task 7（可独立发）: lockLlmConfig 归到团队维度

**Files:** `services/fc/src/lib/routes/team-share.ts`, `packages/app/src/lib/backend/cloud-api/team-workspace-config.ts`, `packages/app/src/stores/team-mode.ts`

- [ ] **Step 1**：`GET /v1/teams/:teamId/workspace-config`（`team-share.ts:118`）的返回体加 `lockLlmConfig`，OpenAPI 同步。
- [ ] **Step 2**：客户端 `team-mode.ts:272` 改读团队配置，build config 的 `team.lockLlmConfig` 降级为默认值。
- [ ] **Step 3**：切团队时必须重取——它是团队策略，跟着 teamId 走，不能缓存到 origin 维度。

放在最后是因为它和前六个 Task 没有依赖，且改的是另一条链路。

**这个 Task 可能要加数据库列，两个环境的迁移方式不同：** self-host 上 push 到 main 命中 `services/supabase/migrations/**` 会自动扫目录应用；**belayo 不会**——`deploy-aliyun-fc.sh` 默认不迁移，要显式 `RUN_MIGRATIONS=1`，且打的是另一个 RDS。代码先于迁移落到 belayo 就是运行时报错，且没有任何 CI 会拦。所以要么把列设成有 DEFAULT 的可选读（迁移前后都能跑），要么 belayo 那次部署带上 `RUN_MIGRATIONS=1` 并单独确认。

前六个 Task 不碰数据库，没有这个问题。

---

## 验证清单

```bash
cd services/fc && pnpm test            # FC 路由 + 契约
pnpm typecheck && pnpm lint            # 前端
pnpm test:unit                         # 含新护栏
docker compose -f deploy/self-host/docker-compose.yml config | grep APP_FEATURES
```

**两个环境部署后都要 curl 一次**（belayo 没有 CI 门禁，这是唯一的验证）：

```bash
curl -s https://api.teamclaw-dev.ucar.cc/v1/config/public | jq   # self-host
curl -s https://teamclaw-api.ucar.cc/v1/config/public | jq       # belayo
```

期望看到 `features.auth` 且值与该环境的 profile 文件一致。**返回 `{}` 说明 profile 文件没进包**（Task 3 Step 3 漏了），不是"没配置"——这两种情况在客户端表现完全一样（都回落 build config），只能靠这个 curl 和启动日志分辨。这正是 #634 的形状：200 + 空 body，没有任何一层报错。

**部署前必读：** FC 镜像构建用 `services/fc/tsconfig.json`（不是 typecheck 用的 test 配置），`src/` 里任何类型错误会让整个 self-host 部署连同 migration 一起挂掉。Task 2 改完务必在本地跑一次镜像构建。

**self-host e2e** (`services/fc/test/self-host-e2e.test.ts`) 只断言 `features` 是 absent-or-object，**不要**把部署门禁绑到 `APP_FEATURES_JSON` 上——它是可选变量，线上没配是正常状态。

---

## 已核对的下游安全性

加 `features` 字段不会打破任何现有客户端：

- **daemon** `BootstrapResponse`（`apps/daemon/src/backend/cloud_api/mod.rs:58`）只声明 `mqtt`，且没有 `deny_unknown_fields` → serde 忽略未知字段。
- **iOS** `BootstrapConfigResponse`（`ServerBrokerConfig.swift:55`）是 Swift `Decodable`，默认忽略未知 key。
- **Expo** `apps/expo/src/lib/mqtt/config.ts:89` 同理。
- **扩展** `manifest.json:7` 的 `host_permissions` 是 `https://*/*`，抓 public 不用改权限；它的 `cloudApiUrl` 由 `build.mjs:128` 按品牌烘入，天然分区。

所以 Task 1-3（服务端）可以先单独上线，客户端按自己的节奏跟。

---

## 实施记录（2026-08-05 已完成）

七个 Task 全部落地。与计划的**五处偏差**，都是执行中发现事实后改的：

**1. profile 是 TS 模块，不是 JSON 文件**（Task 3）

`services/fc/Dockerfile` 的 runtime stage 只 `COPY --from=build /app/dist`，而 `s.yaml` 是 `code: ./` 打包整个目录。JSON 数据文件会**在 belayo 正常、在 self-host 静默消失**——而且客户端完全分辨不出「profile 没进包」和「profile 是空的」。改成 `services/fc/src/lib/feature-profiles.ts`，编译进 `dist/`，两个目标都免疫。计划里的 Task 3 Step 3（确认文件进镜像）因此不再需要。

**2. `lockLlmConfig` 是部署级 flag，不是团队级数据库列**（Task 7）

原计划让它进 `GET /v1/teams/:id/workspace-config`。执行时发现那需要 `team_workspace_config` 加一列 → 迁移 → 而 belayo 的迁移是手工 opt-in（`RUN_MIGRATIONS=1`），代码先到、迁移没到就是 500。

更关键的是：它今天的语义就是**每个 build 一份**（`buildConfig.team.lockLlmConfig`，即每个品牌一份），改成 per-team 是产品变更，不是配置搬家，而用户要的是后者。所以按部署级 flag 实现，语义不变，无需迁移。

**per-team 的版本留作后续**：真要做，就是 `team_workspace_config` 加 `lock_llm_config boolean default false`、两个 repo 实现同步、belayo 那次部署带 `RUN_MIGRATIONS=1`。

**3. `webSso` 仍留在 bootstrap，标 deprecated**

「public 和 bootstrap 不冗余」对 `features` 严格执行了（`scopeToOwnedKeys` 在客户端强制，越界的 key 直接丢），但 `webSso` 没有一起搬。已发版的客户端从 bootstrap 解析 快捷登录 地址，直接删会让它们在升级前登不进去——和「远程关掉 updater」同一类事故。OpenAPI 里标了 `deprecated`，等旧版本淘汰再删。

**4. 换服务器的通知用 DOM 事件，不是导出的 subscribe()**

先按计划做了 `subscribeCloudApiUrl` 导出，结果 3 个既有测试直接挂掉——它们 partial mock 了 `@/lib/server-config`，而 vitest 的 mock 代理对未定义导出**连 `typeof` 都抛**。直接 import 会把这个模块塞进每个监听者的 import graph。改成 `window` 事件（`teamclaw:cloud-api-url-changed`），事件名两边各写一份字面量，注释互相指向。

同样的原因，`remote-features.ts` 里所有对 build-config 的读取都是防御性的（`buildConfig?.features ?? {}`），并且自己实现了 channels 归一化而不是 import `resolveChannelsConfig`——这个模块在几乎所有 gated 界面的 import graph 上，多依赖一个导出就多一批会被无关 mock 打挂的测试。

**5. 顺手修了 OpenAPI 的既有语法错误**

`docs/openapi/teamclaw-api.v1.yaml:201` 有个未加引号的 `` `itemType: org` ``，**整个文件在 main 上就无法解析**（`npm run openapi:lint` 一直是挂的）。不修就没法验证本次加的契约。

### 验证结果

| 检查 | 结果 |
|---|---|
| `services/fc` 路由测试 | 20 passed（新增 8 个 feature-flag 用例） |
| `npm run build`（部署用的 tsconfig） | 通过，`dist/lib/feature-profiles.js` 已生成 |
| `pnpm test:unit` | 429 files / 2652 tests 全绿 |
| `pnpm typecheck` | 通过 |
| `pnpm lint` | 0 error（52 个既有 warning） |
| OpenAPI redocly lint | 0 error / 7 warning（其中 4 个 ambiguous-path 是既有的） |

`services/fc` 的 `npm run typecheck`（tsconfig.test.json）有 9 个错误，改动前后**完全一致**，全在既有 test 文件里，与本次无关。

### 后续：三份 profile 已按各品牌 build config 填好（2026-08-06）

初版两份 profile 都是空的。填值时发现**有三个在跑的 Cloud API，不是两个**：

| profile | 部署 | 品牌来源 |
|---|---|---|
| `self-host` | `api.teamclaw-dev.ucar.cc` | `build.config.production.json`（本仓库） |
| `belayo` | `teamclaw-api.ucar.cc` | 品牌私仓 `brands/betly` |
| `copilot361` | `copilot.accounting.i.test.shopee.io` | 品牌私仓 `brands/copilot361` |

每份都是**照抄该品牌 build config 已经烘死的值**，所以启用当天行为零变化。

**因此必须去掉 `s.yaml` 的默认 profile。** 原来默认 `belayo`，在 profile 为空时无害；一旦有值就成了陷阱——`s.yaml` 同时部署 belayo 和 copilot361，copilot361 那台只要没显式设 profile 就会继承 belayo 的开关，**给从没提供过手机登录的用户打开手机登录**。改成无默认值：不设 = 不覆盖 = 客户端保持 build config，永远安全。compose 保留 `self-host` 默认值，因为那台机器就是唯一一个环境，不存在歧义。

新增两个测试：每份 profile 过一遍真实 resolver 后必须原样出来（拼错的 key 会被 allowlist 静默丢掉），以及没有任何 profile 试图控制 `updater`。

线上验证（belayo 的返回印证了 `brands/betly` 的 `webSSO: true`）：

```
$ curl -s https://teamclaw-api.ucar.cc/v1/config/public
{"webSso":{"loginUrl":"https://admin.mx5.cn/sign-in","storageKey":"sb-supa-auth-token"}}
$ curl -s https://api.teamclaw-dev.ucar.cc/v1/config/public
{}
```

（两边都还没部署本次改动，所以暂时都没有 `features` 块。）

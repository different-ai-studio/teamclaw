# TeamClaw → TeamClu 品牌切换：仓库外的收尾清单

代码侧的改名已经在 `chore/rebrand-teamclu` 分支完成。这份清单只覆盖**代码管不到的部分**——
改名之后必须在 GitHub、DNS、OSS、Apple、Sentry 上同步落地的东西。

## 贯穿全篇的一条规则

> 已经发出去的客户端把旧名字烘死在二进制里，改不了。所以**每一个旧名字都必须作为别名永久保留**，
> 不能停用。

存量装机会一直请求旧的更新地址、旧的 API 主机名、旧的 GitHub release URL。代码里的
`~/.teamclaw` → `~/.teamclu` 有迁移兜底，DNS 和 GitHub 没有。旧名字一停，那批用户就永久断更、
永久连不上后端，且没有任何补救手段。

### 例外：`*.teamclaw-dev.ucar.cc` 已经决定不保留（2026-08-09）

五条 `*.teamclaw-dev.ucar.cc` 记录在 DNS 切换时被**删除**而不是保留为别名，且经确认这是有意的
决定，不是失误。后果照上面那条规则：**所有存量装机——桌面端、iOS、betly、copilot361——从此
连不上后端，只能引导重装新版本**，没有服务端补救手段。

这条例外只适用于 `-dev` 那五个主机名。GitHub 仓库重定向、`teamclaw.ucar.cc`（betly 更新清单）、
`teamclaw-api.ucar.cc`（belayo 后端）**仍然适用原规则**——它们服务的是自动更新链路，断了连
"重装新版本"这条路都没有。

## 合并前必须就位

| 项 | 现状 | 要做什么 |
|---|---|---|
| GitHub 仓库 | `different-ai-studio/teamclaw` | 改名为 `teamclu`。**此后永远不要在该 org 下再建叫 `teamclaw` 的仓库**——一建，重定向立即失效，存量正式版当场断更（`apps/desktop/tauri.conf.json` 的更新地址烘死了旧 URL） |
| 品牌私仓 | `teamclaw-enterprise-branding` | 若一起改名，同步更新仓库变量 `vars.BRANDING_REPO`（是变量不是硬编码，改一处即可） |
| 安装脚本一行命令 | `raw.githubusercontent.com/.../teamclaw/main/scripts/install-mac.sh` | 改名后用 curl 实测该 URL 是否仍然重定向；raw 域对改名的重定向行为与 web 不同，必须实测 |

## 各发布通道放行前必须就位

### 域名（`ucar.cc` 子域）

代码里已全部指向新主机名。**新主机名必须先解析 + 签好证书，旧主机名保留为 CNAME。**

| 旧 | 新 | 谁在用 |
|---|---|---|
| `api.teamclaw-dev.ucar.cc` | `api.teamclu-dev.ucar.cc` | Cloud API，所有客户端 |
| `mqtt.teamclaw-dev.ucar.cc` | `mqtt.teamclu-dev.ucar.cc` | MQTT over WSS |
| `supabase` / `studio` / `emqx.teamclaw-dev.ucar.cc` | `…teamclu-dev…` | 网关 / 控制台 |
| `teamclaw.ucar.cc` | `teamclu.ucar.cc` | **betly 的更新清单地址**（`release-oss.yml` 的 `CDN_BASE_DEFAULT`）。新主机不存在就发布 betly，等于把 betly 的 `latest.json` 指向 404 |
| `teamclaw-api.ucar.cc` | `teamclu-api.ucar.cc` | belayo 后端，betly 的 `cloudApiUrl` |

#### betly 的 CDN 被临时钉回旧域名（2026-08-10）

仓库变量 **`vars.OSS_CDN_BASE = https://teamclaw.ucar.cc`** 已设置。`release-oss.yml` 里那行是

```yaml
CDN_BASE_DEFAULT: ${{ vars.OSS_CDN_BASE || 'https://teamclu.ucar.cc' }}
```

——**文件上写着新域名，实际生效的是变量里的旧域名**。不看这一节会被文件误导。

起因：`nightly-release-oss` 是**定时**的（16:20 UTC），2026-08-09 那次跑的时候 `teamclu.ucar.cc`
还不存在。"发布 latest.json 到 OSS" 这步**成功了**，只有最后的"刷新 CDN 缓存"失败——也就是说
`beta/latest.json` 已经被覆盖成一份下载地址指向不存在主机的清单。旧 CDN 缓存没刷掉，所以当时
还在发旧清单，但缓存一过期存量 betly 客户端就会看到一个下不动的更新。

钉回旧域名是对的，不只是权宜：存量 betly 客户端烘死的本来就是 `teamclaw.ucar.cc`。

**什么时候删掉这个变量**：`teamclu.ucar.cc` 的 HTTPS 配好之后。删掉变量就自动回落到文件里的新
域名，不需要改代码。当前状态：域名已建、`online`、类型 `download`（与旧域名一致）、CNAME 已解析，
但 **HTTPS 仍是 off、无证书**。账号里 11 张证书全是单域名的，没有 `*.ucar.cc` 通配符可复用；
CDN 产品没有签发免费证书的 API，控制台那个「免费证书」走的是 CAS。

copilot361 不受影响——它在 `brand.json` 里自带 `oss.cdnBase`，只有 betly 继承这个默认值。

#### 已完成（2026-08-09）

五个 `-dev` 新主机名已解析到 `47.112.210.217`，箱子 `.env` 已切、Caddy 已签发全部五张
Let's Encrypt 证书，`https://api.teamclu-dev.ucar.cc/healthz` 返回 `{"ok":true}`。

要点：**Caddy 只给自己配置里出现的名字签证书**，DNS 指过来它不会自动去签——`.env` 不改，
新主机名就是 TLS 握手直接 `tlsv1 alert internal error`。

`.env` 里要改的不止 `*_DOMAIN` 五个。`SUPABASE_PUBLIC_URL` / `API_EXTERNAL_URL` /
`SITE_URL` / `MQTT_PUBLIC_BROKER_URL` 是**单独存的值**，不会跟着 `*_DOMAIN` 走；漏了它们，
GoTrue 会继续往旧主机发重定向。备份在箱子上的 `.env.bak.pre-teamclu-dns`。

#### 遗留：EMQX 8883 的 MQTTS 是坏的（先于这次改名）

Caddy 把证书存成 `0700 root:root`，而 emqx 容器跑在 uid 1000 下，读不到——listener 能 bind，
但每个连接都在握手阶段被丢弃、不发证书。用 uid 1000 读**改名前**那份证书同样是
`Permission denied`，所以不是这次切换造成的。

目前没有使用者：`/v1/config/bootstrap` 下发的是 `mqtt://…:1883`，iOS 也是
`mqttUseTls: false`，所以一直没人察觉。要修得把证书复制到 emqx 读得到的地方，改路径没用。

### 自建机（ECS `47.112.210.217`）的 `.env`

| 变量 | 改成 | 说明 |
|---|---|---|
| `ADDITIONAL_REDIRECT_URLS` | 同时包含 `teamclu://auth-callback` **和** `teamclaw://auth-callback` | 桌面深链 scheme 变了；旧版客户端仍回调旧 scheme，两个都留着，等存量清空再删 |
| `APPLE_CLIENT_IDS` | **追加** `com.teamclu.mobile`（逗号分隔，不要替换） | Apple 的用户 `sub` 按开发者 team 稳定，追加就能延续身份；直接替换会让旧 App 无法登录 |
| `APNS_TOPIC` | `com.teamclu.mobile` | **不是改名，是新增**：切换那会儿这台机器根本没配过 APNs，旧装机当时也收不到推送，所以切换不损失任何东西。整套 APNs 变量现已配齐，见下 |
| `BUCKET` | `teamclu-team`（自建 compose 默认值已改） | OSS bucket 要先建出来，否则新团队开通共享盘直接失败 |

#### 已核实（2026-08-10）：Apple 相关的值不在 `.env` 里

这台箱子的 `.env` **没有 `APPLE_CLIENT_IDS` 这个键**（也没有 `ENABLE_APPLE_SIGNUP`），所以生效的是
compose 里的默认值。也就是说改仓库里那个默认值就等于改线上，不需要另外动 `.env`——但反过来，
如果只看 `.env` 会以为 Apple 登录没配。

`docker compose exec auth env` 读到的实际值：

```
GOTRUE_EXTERNAL_APPLE_CLIENT_ID = tech.teamclaw.mobile,com.teamclu.mobile
GOTRUE_EXTERNAL_APPLE_ENABLED   = true
ADDITIONAL_REDIRECT_URLS        = http://127.0.0.1:*/callback,teamclaw://auth-callback,teamclu://auth-callback
```

排查这类问题时以容器里的 env 为准，不要以 `.env` 为准。

（这份清单原先还列了一行 `APNS_TOPIC`，是抄错了容器：compose 的 `auth` 服务下没有任何
`APNS_*`，`docker compose exec -T auth printenv APNS_TOPIC` 是空的。APNs 变量只发给 `fc`。）

#### iOS 推送：切换时是空的，现在已配齐（2026-08-16 核实）

`services/fc/src/lib/push-deps.ts` 的 `buildApns()` **无条件**构造 APNs 客户端，不做"是否已配置"
的判断——签名 key 是空字符串时，每次推送都在 APNs 那边失败。所以下面这些必须凑齐，
只设 `APNS_TOPIC` 等于没配。`deploy/self-host/.env.example` 那句 "all five needed together"
说的就是这个；compose 的 `fc.environment` 里这六个都写成 `${VAR:-}`，`.env` 不给就是空串。

| 变量 | 从哪来 |
|---|---|
| `APNS_PRIVATE_KEY_P8` | 开发者门户的 APNs Auth Key（`.p8` 全文）。**token-based key 是 team 级的，跨 bundle id 通用，不用为改名新建** |
| `APNS_KEY_ID` | 同一把 key 的 Key ID（文件名 `AuthKey_<KEYID>.p8` 里那段） |
| `APNS_TEAM_ID` | `43G5A6G9QV`（同 `apps/ios/project.yml` 的 `DEVELOPMENT_TEAM`） |
| `APNS_TOPIC` | 新 bundle id `com.teamclu.mobile` |
| `APNS_ENV` | `production`——`AMUXApp/AMUX.entitlements` 是 `aps-environment: production`。留空也默认 production |
| `PUSH_WEBHOOK_SECRET` | 推送 webhook 的鉴权共享密钥 |

**2026-08-16 复核：六个在 `.env` 里都有值，`docker compose exec -T fc printenv <VAR>` 六个也都非空。**
所以下面 Apple 一节第 4 步「新建或重新映射 APNs key」不用再做了。复核只看键是否为空，不要把值贴出来。

### Google OAuth 回调地址（控制台，无 API）

**这一项最初漏在清单外，是线上报 `redirect_uri_mismatch` 之后才补的。**

GoTrue 的回调地址是从 `SUPABASE_DOMAIN` 插值出来的：

```
GOTRUE_EXTERNAL_GOOGLE_REDIRECT_URI = https://<SUPABASE_DOMAIN>/auth/v1/callback
```

域名一改，发给 Google 的就是新地址，而 Google 对重定向 URI 做**精确字符串匹配**。必须去
Google Cloud Console → API 和服务 → 凭据 → 对应的 OAuth 2.0 客户端（类型必须是「Web 应用」）
→ 已获授权的重定向 URI，把新地址加进去。**Google 不提供管理这个的 API，只能手工。**

不用浏览器也能验证是否生效——直接请求 authorize 端点看它放行还是回 `redirect_uri_mismatch`：

```bash
curl -s -o /dev/null -w '%{redirect_url}\n' -G \
  --data-urlencode "client_id=<CLIENT_ID>" \
  --data-urlencode "redirect_uri=https://supabase.teamclu-dev.ucar.cc/auth/v1/callback" \
  --data-urlencode "response_type=code" --data-urlencode "scope=email" \
  https://accounts.google.com/o/oauth2/v2/auth
```

返回的 URL 里带 `authError=`（base64，解出来是 `redirect_uri_mismatch`）就是没生效；跳到登录/
同意页就是好了。2026-08-10 已核实新地址通过。

### 存量设备：daemon 的后端地址不跟着 App 走

`~/.amuxd/backend.toml` 的 `url` 和 `daemon.toml` 的 `[mqtt] broker_url` 是 `amuxd init` 时写进去的，
**不随 App 的 build config 更新**。所以旧域名删除后，即使装上改名后的新版 App，daemon 仍然去连
旧地址，表现是 MQTT 一直连不上，日志里是：

```
initial Cloud API token fetch failed ... url (https://api.teamclaw-dev.ucar.cc/v1/auth/refresh)
bootstrap mqtt fetch failed; relying on last-known broker in daemon.toml if present
```

链条：拿 token 失败 → 拿 bootstrap（broker 地址平时由 Cloud API 下发）失败 → 回落到
`daemon.toml` 里"最后已知的 broker"，那也是旧域名 → 永远连不上。

**「引导用户重装」这条路不够**——重装 App 不会重写 `~/.amuxd/`。每台受影响的设备要么手工改这两个
文件后重启 daemon，要么重新 `amuxd init`（会换 actor 身份）。手工改法：

```bash
sed -i '' 's|api\.teamclaw-dev\.ucar\.cc|api.teamclu-dev.ucar.cc|' ~/.amuxd/backend.toml
sed -i '' 's|mqtt\.teamclaw-dev\.ucar\.cc|mqtt.teamclu-dev.ucar.cc|' ~/.amuxd/daemon.toml
```

`refresh_token` / `team_id` / `actor_id` 都保留；连上之后 broker 地址还会被 Cloud API 的 bootstrap
覆盖成权威值。

### Apple

`tech.teamclaw.mobile` → `com.teamclu.mobile` 是**新建一个 App Store Connect 应用记录**，不是改名：

1. 开发者门户建 App ID `com.teamclu.mobile`（+ `.uitests`）
2. `fastlane match` 重新签发描述文件（`Matchfile` / `Appfile` / `Fastfile` 代码里已改）
3. ASC 建新 App 记录，重新配 TestFlight 测试组
4. ~~新建或重新映射 APNs key~~ —— 不需要。token-based APNs Auth Key 是 team 级的，跨 bundle id
   通用；自建机上六个 `APNS_*` / `PUSH_WEBHOOK_SECRET` 已配齐（2026-08-16 核实），见上文
5. 旧记录 `tech.teamclaw.mobile` 保留但不再发版；已装用户不会自动迁移，需要引导重装

### Sentry

项目 slug 改名（`.claude/skills/sentry-*` 已按新 slug 更新）：

- `teamclaw` → `teamclu`
- `teamclaw-react` → `teamclu-react`
- `teamclaw-ios` → `teamclu-ios`
- `teamclaw-expo` → `teamclu-expo`

Sentry 改项目 slug 之后，历史 issue 的 short-id 前缀会跟着变成 `TEAMCLU-*`，文档里的引用已同步。

## 品牌私仓 `brands/` 的改动

### `brands/betly/build.config.json`

```diff
-  "cloudApiUrl": "https://teamclaw-api.ucar.cc",
+  "cloudApiUrl": "https://teamclu-api.ucar.cc",
   "app": {
-    "name": "TeamClaw",
-    "displayName": "Betly TeamClaw",
-    "shortName": "teamclaw",
+    "name": "TeamClu",
+    "displayName": "Betly TeamClu",
+    "shortName": "teamclu",
```

`brands/betly/brand.json` 的 `displayName` 同步改成 `TeamClu Live Beta`。

**`shortName` 改不改都能跑**：`is_official_brand()` 保留了 `teamclaw` 作为 legacy 值，所以即使
betly 继续声明 `shortName: "teamclaw"`，它依然被判为官方品牌、依然落在 `~/.teamclu` 和 `~/.amuxd`。
保留这个 legacy 值是刻意的——去掉它会把每一台 betly 装机重新归类为白标，数据被甩到
`~/.teamclaw` + `~/.amuxd-teamclaw`。

betly 没有声明 `identifier`，继承 `tauri.conf.json` 的默认值，所以它的 bundle id 会随主仓
一起从 `com.teamclaw.app` 变成 `com.teamclu.app`。macOS 上自动更新能跨过去（原地替换 .app），
**Windows 不行**——NSIS 的卸载键由 identifier + productName 派生，会变成并排安装两份。

### `brands/copilot361/build.config.json`

copilot361 自带 `identifier: com.copilot361.app` 和 `shortName: copilot361`，主仓改名碰不到它。
但它显式 pin 了 `"scheme": "teamclaw"`，已决定改成自己的品牌 scheme：

```diff
-    "scheme": "teamclaw",
+    "scheme": "copilot361",
```

它本来就是独立品牌，用自己的 scheme 才对；顺带解决了 copilot361 和官方版在同一台机器上
抢注同一个 `teamclaw://` 的冲突。

**代价**：`scripts/lib/branding.js` 的 `applyIdentityToTauriConf` 只写入**一个** scheme
（`desktop.schemes = [app.scheme]`），所以 copilot 桌面端只能注册 `copilot361://`。发给
copilot 用户的旧 `teamclaw://` 邀请/会话链接，从此不会再唤起 copilot。解析器已经接受旧
scheme，但操作系统层面的 URL 路由不认——这个靠代码补不回来。

若要避免这一点，需要把 `app.scheme` 扩展成支持数组（让 copilot 同时注册
`copilot361` 和 `teamclaw`）。目前没有做。

## 箱子上已经存在的东西（改名扫到了，已改回）

这些不是品牌字符串，是**那台 ECS 上已经存在什么**。改名把它们一起改了，任何一条都足以让
一次部署看起来像把环境清空了：

| 位置 | 恢复成 | 改了会怎样 |
|---|---|---|
| `docker-compose.yml` / `docker-compose.podman.yml` 的 `name:` | `teamclaw-self-host` | 容器和卷全都带这个前缀。改名不会重命名任何东西——compose 当成全新项目，19 个容器起在全新空卷上，数据库、Caddy 已签的证书、EMQX 状态全部搁浅在孤儿项目里 |
| `smoke/run-e2e.sh` 的容器名 | `teamclaw-self-host-fc-1` | 跟着 `name:` 走，必须一致 |
| `apps-db-init` 的库名 | `teamclaw_apps` | 库已经在线上；改名只会在旁边再建一个空的 |
| 两个 deploy workflow 的 `cd` 路径 | `/opt/teamclaw` | 箱子上就叫这个，`/opt/teamclu` 不存在，部署第一步就失败 |
| `emqx.conf` 的 certfile/keyfile | 见上，改由 `${MQTT_DOMAIN}` 派生 | Caddy 手上只有旧名字的证书，路径写成新名字 = 8883 listener 起不来，MQTTS 全断 |

想真的改成 `teamclu-*`，得先在箱子上迁移卷和数据库、再改这里，不能只改仓库。

## 刻意没有改名的东西

这些是**关于磁盘上/第三方那里已经存在什么**的事实，不是品牌字符串。改了它们，读它们的迁移代码就失效了：

| 位置 | 保留的字面量 | 原因 |
|---|---|---|
| `crates/teamclu-types/src/mqtt.rs` | `MQTT_FALLBACK_TEAM_ID = "teamclaw"` | **线上常量**。无 team 时 MQTT topic `amux/<team>/<actor>/…` 里的路径段，daemon 与 iOS App 各自独立升级。会合点没有迁移可言：一边升级一边没升的设备对会**静默**收不到对方消息。Swift 侧 `MQTTTopics.fallbackTeamID` 是镜像，必须相等 |
| `crates/teamclu-runtime-env/src/storage_namespace.rs` | `teamclaw` / `teamclawdev` 作为 `is_official_brand()` 的 legacy 值 | betly 仍在发 `shortName: "teamclaw"`；见上 |
| `apps/desktop/src/commands/storage_migration.rs` | `.teamclaw` / `teamclaw.json` / `teamclaw-team` | 迁移要靠这些名字找到旧数据 |
| `apps/desktop/src/commands/team_share/disconnect.rs` | `LEGACY_TEAM_REPO = "teamclaw"` | 本来就是用来找旧目录的常量；改了永远找不到，旧目录留在用户工作区里 |
| `apps/desktop/src/commands/team.rs` | `default_shared_dir_name() = "teamclaw"` | 缺 `sharedDirName` 字段的**旧配置**解析成什么。改了会让这些工作区去找一个从未创建过的团队盘 |
| `crates/teamclu-runtime-env/src/env_catalog.rs` | `workspace/teamclaw/_secrets` 候选路径 | 团队密钥的 legacy 目录 |
| `apps/desktop/src/commands/server_config.rs` | `deprecated_config_paths()` 里的 `teamclaw` | 顾名思义，是待清理的旧路径 |
| `apps/daemon/src/runtime/refresh_watch.rs` | `workspace/teamclaw/_secrets` watch root | 同上 |
| `packages/app/src/lib/{invite,session}-deeplink.ts`、iOS `Info.plist` / 三处 scheme 数组 | 接受 `teamclaw://` | 已经发给同事的邀请/会话链接带的就是旧 scheme |
| `packages/app/src/lib/auth/session-store.ts` | `teamclaw.session.v1` | 首次读取时改键；改掉等于把所有用户登出 |

`~/.amuxd/teamclaw/`（daemon 的会话/消息/想法存储）没有沿用旧名，而是**做了迁移**：
`apps/daemon/src/teamclu/mod.rs` 的 `migrate_rebrand_state_dir()` 在第一次读取前把整个目录搬到
`~/.amuxd/teamclu/`。桌面端那个迁移够不到这里——它管的是 `~/.teamclaw` 和工作区元数据，
而这棵树在 daemon 自己的 home 下。少了它，改名会让每台已有设备看起来**没有任何历史记录**。

## 切换后的验证

1. `cargo metadata --locked` 通过（CI 用 `--locked` 编 daemon，lockfile 不一致直接挂）
2. 装一个改名前的旧版本，再升级到新版本，确认 `~/.teamclaw` 被搬到 `~/.teamclu`、会话和技能都在、
   用户没有被登出
3. 确认 sidecar 二进制**确实重新编译过**——`cargo` 会静默产出旧二进制（4.9s 就 "Finished" 但没编），
   部署前用 `strings` 验证 `amuxd` / `teamclu-introspect` 里是新名字
4. **不要轮换 Tauri 签名私钥**。betly 和 copilot361 共用 `1D087DF9` 这一把；改名期间换 key
   会一次性打断所有品牌的自动更新
5. **FC 镜像能不能构建，CI 绿了也不算数。** Dockerfile 跑的是 `npm run build`
   （`tsc -p tsconfig.json`），而 CI 的 typecheck 用的是 `tsconfig.test.json`。`src/` 里的类型
   错误只在镜像构建时才炸，并且会把 self-host 部署和数据库迁移一起带挂。dispatch 之前先在本地
   `cd services/fc && npx tsc -p tsconfig.json --noEmit`

## 已跑通的部署（2026-08-10）

改名后三条部署链路都验证过了：

| Workflow | 结果 | 关键证据 |
|---|---|---|
| Daemon Deploy | ✅ | `amuxd-smoke: PASS`，箱子上跑的是 `teamclu-amuxd` 镜像 |
| Self-Host Deploy | ✅ | e2e `pass 11, fail 0`；健康检查打的是 `https://api.teamclu-dev.ucar.cc` |
| TestFlight | ✅ | 2026-08-09 已用 `com.teamclu.mobile` 成功发布过一次 |

Self-Host Deploy 那次最值得看的一行是容器名仍然是 **`teamclaw-self-host-*`**——证明「箱子上已经
存在的东西」那一节里把 compose `name:` 改回去是有效的。要是没改回去，compose 会把这当成全新项目，
19 个容器起在全新空卷上。

**注意 `daemon-deploy` 的触发路径包含它自己的 workflow 文件**（`.github/workflows/daemon-deploy.yml`），
所以只是编辑它就会触发一次部署。恢复触发器的那个 PR 合并时就这样触发了一次（结果是好的，但不是
预期内的）。`self-host-deploy` 和 `testflight` 没有这个自引用，需要手动 dispatch。

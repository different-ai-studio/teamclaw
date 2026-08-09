# TeamClaw → TeamClu 品牌切换：仓库外的收尾清单

代码侧的改名已经在 `chore/rebrand-teamclu` 分支完成。这份清单只覆盖**代码管不到的部分**——
改名之后必须在 GitHub、DNS、OSS、Apple、Sentry 上同步落地的东西。

## 贯穿全篇的一条规则

> 已经发出去的客户端把旧名字烘死在二进制里，改不了。所以**每一个旧名字都必须作为别名永久保留**，
> 不能停用。

存量装机会一直请求旧的更新地址、旧的 API 主机名、旧的 GitHub release URL。代码里的
`~/.teamclaw` → `~/.teamclu` 有迁移兜底，DNS 和 GitHub 没有。旧名字一停，那批用户就永久断更、
永久连不上后端，且没有任何补救手段。

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

### 自建机（ECS `47.112.210.217`）的 `.env`

| 变量 | 改成 | 说明 |
|---|---|---|
| `ADDITIONAL_REDIRECT_URLS` | 同时包含 `teamclu://auth-callback` **和** `teamclaw://auth-callback` | 桌面深链 scheme 变了；旧版客户端仍回调旧 scheme，两个都留着，等存量清空再删 |
| `APPLE_CLIENT_ID` | **追加** `com.teamclu.mobile`（逗号分隔，不要替换） | Apple 的用户 `sub` 按开发者 team 稳定，追加就能延续身份；直接替换会让旧 App 无法登录 |
| `APNS_TOPIC` | `com.teamclu.mobile` | 注意：旧 App 的 topic 仍是 `tech.teamclaw.mobile`，切了之后旧装机收不到推送 |
| `BUCKET` | `teamclu-team`（自建 compose 默认值已改） | OSS bucket 要先建出来，否则新团队开通共享盘直接失败 |

### Apple

`tech.teamclaw.mobile` → `com.teamclu.mobile` 是**新建一个 App Store Connect 应用记录**，不是改名：

1. 开发者门户建 App ID `com.teamclu.mobile`（+ `.uitests`）
2. `fastlane match` 重新签发描述文件（`Matchfile` / `Appfile` / `Fastfile` 代码里已改）
3. ASC 建新 App 记录，重新配 TestFlight 测试组
4. 新建或重新映射 APNs key
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

### `brands/copilot361/build.config.json` — 需要一个决定

copilot361 自带 `identifier: com.copilot361.app` 和 `shortName: copilot361`，主仓改名碰不到它。
但它显式 pin 了：

```json
"scheme": "teamclaw"
```

存量 copilot361 装机注册的就是 `teamclaw://`。三个选项：

1. **保持 `teamclaw`** — 存量深链继续可用，但 `teamclaw` 这个词在 copilot 用户机器上留着
2. **改成 `teamclu`** — 与主仓一致，但旧版 copilot 的深链失效
3. **改成 `copilot361`**（推荐）— 它本来就是独立品牌，用自己的 scheme 才对；且能解决现在
   copilot361 和官方版在同一台机器上抢注同一个 `teamclaw://` 的冲突

无论选哪个，旧深链的失效范围都只限 copilot361，不影响主线。

## 刻意没有改名的东西

这些是**关于磁盘上/第三方那里已经存在什么**的事实，不是品牌字符串。改了它们，读它们的迁移代码就失效了：

| 位置 | 保留的字面量 | 原因 |
|---|---|---|
| `crates/teamclu-runtime-env/src/storage_namespace.rs` | `teamclaw` / `teamclawdev` 作为 `is_official_brand()` 的 legacy 值 | betly 仍在发 `shortName: "teamclaw"`；见上 |
| `apps/desktop/src/commands/storage_migration.rs` | `.teamclaw` / `teamclaw.json` / `teamclaw-team` | 迁移要靠这些名字找到旧数据 |
| `packages/app/src/lib/auth/session-store.ts` | `teamclaw.session.v1` | 首次读取时改键；改掉等于把所有用户登出 |

## 切换后的验证

1. `cargo metadata --locked` 通过（CI 用 `--locked` 编 daemon，lockfile 不一致直接挂）
2. 装一个改名前的旧版本，再升级到新版本，确认 `~/.teamclaw` 被搬到 `~/.teamclu`、会话和技能都在、
   用户没有被登出
3. 确认 sidecar 二进制**确实重新编译过**——`cargo` 会静默产出旧二进制（4.9s 就 "Finished" 但没编），
   部署前用 `strings` 验证 `amuxd` / `teamclu-introspect` 里是新名字
4. **不要轮换 Tauri 签名私钥**。betly 和 copilot361 共用 `1D087DF9` 这一把；改名期间换 key
   会一次性打断所有品牌的自动更新

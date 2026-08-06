# 团队 Skills Registry 设计

> 目标落位：`docs/architecture/team-skills-registry.md`
> 状态：设计稿，待评审。文末「待定问题」还剩 5 条未拍板（#4 已定）。

## 1. 要解决什么

两个问题，都不是保密问题。

**职责不清晰。** 现在整个系统认识的 skill 元数据只有 `name` 和 `description` 两个字段，而且不是 YAML 解析，是正则抠行（`packages/app/src/lib/git/skill-loader.ts:14` 一条 regex，`apps/daemon/src/config/roles_skills.rs:175` 一个 `strip_prefix("description:")`）。于是「干什么、什么时候别用、触发词、依赖什么」全挤进 description 一个自由文本里。内置的 `macos-control` 就是标本：description 里塞了 `Note: NEVER invoke this skill for...` 和 `Trigger words: ...`，旁边的 `compatibility` 字段没有任何代码读。没有结构，就没法比较、没法去重、没法分类。

**每人全量，噪音大。** `teamclaw-team/skills/` 全量同步到每个成员机器，`collectTeamSkillPaths()` 把整个目录喂给加载器。团队里任何人加的 skill，所有人的 agent 上下文里都有。

**明确不解决：保密。** 现有加密是一团队一把 `ossTeamSecret`（`apps/daemon/src/sync/secret_store.rs`），全体成员共用，防的是云厂商不是同事。本设计不引入成员间的可见性隔离，ACL 留作后续扩展位。

## 2. 现状盘点

**已经有的（可复用）：**

| 位置 | 能力 |
|---|---|
| `services/fc/src/db/schema/oss-sync.ts` | `amuxc_blobs` 内容寻址去重、`amuxc_upload_sessions` 分片上传 |
| `services/fc/src/lib/oss-store.ts` / `sts.ts` | OSS 对象读写、STS 签名 |
| `apps/desktop/src/commands/clawhub.rs` | **完整的包消费端**：zip 下载 → 解压到 `.teamclaw/skills/<slug>` → 写 `.clawhub/origin.json` → lockfile 记版本 → 自动写 `permission.skill` → `is_global` 切全局/工作区 |
| `packages/app/src/components/settings/SkillsMarketplace.tsx` | 市场 UI 骨架（1295 行），已含搜索/安装/更新交互 |
| `apps/daemon/src/config/roles_skills.rs` | `upsert_skill` / `delete_skill`，本地 skill 的增删改 |

**没有的：**

- ClawHub 集成是**纯消费端**，`clawhub.rs` 里没有任何 publish/upload 代码。发布侧（打包、校验、版本、存储、鉴权）要在 FC 上从零写。
- 结构化的 skill 元数据。
- 「谁装了什么」的服务端记录。

## 3. 方案总览

在 FC 上建独立的团队 skills registry，按**包**分发。

```
桌面端                      FC /v1                     存储
─────────────────────────────────────────────────────────────
浏览市场      ──────────>  GET  /teams/:id/skills   ──> Postgres 元数据
发布 skill    ──────────>  POST /teams/:id/skills   ──> zip → Supabase Storage (amuxc_blobs)
安装          ──────────>  GET  .../download        ──> 签名 URL
                           PUT  .../install         ──> Postgres 安装记录
                    │
                    └─> 复用 clawhub.rs 的解压/lockfile/permission 管线
```

三条约束：

1. **客户端不直连 Supabase。** `cloud_api` 是唯一客户端后端，`packages/app/src/lib/backend/__tests__/no-supabase-import.test.ts` 是守卫。表建在 Supabase Postgres，访问一律走 FC `/v1`。
2. **包体走 Supabase Storage，不进 OSS。**（2026-08-06 反转此前决定：注册表刚合并、生产环境尚无真实 skill 包，改动是干净切换而非数据迁移。）私有 bucket `team-skills`，签名 URL 由 FC 的 service-role 客户端签发（`services/fc/src/lib/skills-storage.ts`）。`amuxc_blobs` 仍是内容哈希去重/记账表，`oss_key` 列复用为 Supabase Storage 的 object path（该表也被 `amuxc_files` 等无关的 OSS 同步功能共用，那部分继续走 OSS，不受影响）。
3. **只有 registry 是发行面。** `teamclaw-team/skills/` 最终退出团队同步（时机见待定 #1），否则两套管线传同一批内容、版本语义作废。

## 4. 数据模型

新增三张表，blob 复用 `amuxc_blobs`。

### `team_skills` — 每个 skill 一行

| 列 | 类型 | 说明 |
|---|---|---|
| `id` | uuid pk | |
| `team_id` | uuid fk teams.id cascade | |
| `slug` | text | 团队内唯一，`^[a-z0-9][a-z0-9-]{1,63}$` |
| `owner_actor_id` | uuid fk actors.id restrict | **负责人**，默认发布者，可转交 |
| `summary` | text | 一句话，≤80 字 |
| `category` | text | **枚举**，不是自由文本 |
| `when_to_use` | text | |
| `when_not_to_use` | text | |
| `requires` | jsonb null | 选填：平台 / MCP server / 外部凭据 |
| `status` | text | `draft` \| `published` \| `deprecated` |
| `superseded_by` | text null | deprecated 时指向替代者 slug |
| `latest_version` | int | |
| `created_by` / `created_at` / `updated_at` | | |

唯一索引 `(team_id, slug)`。

### `team_skill_versions` — 追加式版本历史

| 列 | 类型 | 说明 |
|---|---|---|
| `id` | uuid pk | |
| `skill_id` | uuid fk cascade | |
| `version` | int | 从 1 递增 |
| `content_hash` | text | zip 的 sha256，对应 `amuxc_blobs.content_hash` |
| `size` | bigint | |
| `changelog` | text | **必填** |
| `summary` / `when_to_use` / `when_not_to_use` / `requires` | | **快照冗余**——装了旧版的人该看到旧版的说明，不是当前的 |
| `created_by` / `created_at` | | |

唯一索引 `(skill_id, version)`。

> 为什么冗余快照：元数据在 `team_skills` 上是「当前状态」，在版本行上是「那一版的事实」。没有快照，改一次描述就把所有历史版本的说明改写了。

### `team_skill_installs` — 谁装了什么

| 列 | 类型 | 说明 |
|---|---|---|
| `id` | uuid pk | |
| `team_id` / `actor_id` | uuid fk | |
| `skill_id` | uuid fk cascade | |
| `installed_version` | int | |
| `scope` | text | `global` \| `workspace`（见待定 #2） |
| `workspace_id` | uuid null | scope=workspace 时必填 |
| `installed_at` / `updated_at` | | |

唯一索引 `(actor_id, skill_id, scope, workspace_id)`。

**`actor_id` 泛化两种安装主体**，这是本设计不需要额外「指派表」的原因：

| 主体 | 谁来装 | 说明 |
|---|---|---|
| `actor_type = member` | 成员自己 | 自助按需安装，治噪音 |
| `agent.visibility = 'team'` 的 agent actor | **管理员直接装** | 团队共享 agent 是团队资产，不存在个人意志要绕过 |

服务端记安装，对成员 actor 是为了「已装 / 有更新」标记和推广效果统计——**不是权威**，权威是本地 lockfile，允许漂移。对 team agent actor 则**是权威**：它决定那个 agent 该加载哪些 skill。

### 建表位置

`services/supabase/migrations/` 加一个 `.sql`（推 main 自动跑），同时在 `services/fc/src/db/schema/` 加 drizzle schema 并挂进 `drizzle.config.ts` 的 schema 数组。两边都要，否则本地类型和线上表会分叉。

## 5. API

按 `CLAUDE.md` 规定的顺序实现：

1. `docs/openapi/teamclaw-api.v1.yaml` 先定义端点
2. `services/fc/src/lib/repository-contract.ts` 定契约
3. `services/fc/src/lib/business-api.ts` 加路由
4. `services/fc/src/lib/pg-repo/` + `supabase-repo/` 实现
5. `services/fc/test/` 加测试
6. 客户端接线

端点：

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/v1/teams/:id/skills` | 列表，带 `installed` / `hasUpdate` 标记，支持 category 过滤和搜索 |
| GET | `/v1/teams/:id/skills/:slug` | 详情 + 版本列表 |
| POST | `/v1/teams/:id/skills` | 发布新 skill（两步上传：prepare 拿签名 URL → complete 提交元数据） |
| POST | `/v1/teams/:id/skills/:slug/versions` | 发新版本 |
| PATCH | `/v1/teams/:id/skills/:slug` | 改元数据 / 转交 owner / 标记 deprecated |
| GET | `/v1/teams/:id/skills/:slug/versions/:v/download` | 返回 Supabase Storage 签名 URL |
| PUT | `/v1/teams/:id/skills/:slug/install` | 记录安装（`actorId` + version + scope） |
| DELETE | `/v1/teams/:id/skills/:slug/install` | 记录卸载 |

鉴权：全部要求团队成员身份。`PATCH` 和 `POST versions` 额外要求是 `owner_actor_id` 本人或团队 owner。

`install` / 卸载的 `actorId` 决定权限门：

- 目标是**调用者自己的 member actor** → 放行
- 目标是 **`visibility='team'` 的 agent actor** → 要求团队 owner，或该 agent 的 `owner_member_id`。沿用 `pg-repo/agents.ts` 里 visibility 切换那套 owner-gated 判断，不新造一套
- 目标是**别人的 member actor** → 拒绝。管理员不能替成员做安装决定

**别忘了 FC 的两个部署目标**：新增环境变量要同时进 `services/fc/s.yaml` 和 `deploy/self-host/docker-compose.yml` 的 `environment:` 白名单，缺一个就在某一边静默丢失。本设计不新增 env（复用两边已有的 `SUPABASE_URL` / `SUPABASE_SERVICE_ROLE_KEY`）。

## 6. 发布门：6 个必填字段

这是治「职责不清晰」的**唯一机制**。发布必须交出：

| 字段 | 为什么必填 |
|---|---|
| `owner` | 「这玩意归谁」有答案 |
| `summary` | 限长，逼出一句话说清楚 |
| `category` | 枚举，让同类可比较 |
| `when_to_use` | 从 description 里拎出来 |
| `when_not_to_use` | **最关键**——两个重叠的 skill 只有边界写出来才能并排比较 |
| `changelog` | 每次发版必填，让「谁改了什么」有记录 |

`requires` 选填（不是每个 skill 都有依赖，强制会逼出「无」这种垃圾值）。`slug` / `version` 系统生成。

**辅助机制：**

- **相似度检查**：发布时和已有 skill 的 summary + when_to_use 做相似度比对，命中阈值弹提示「和 `xxx` 有 82% 相似，确认要新建而不是发它的新版本吗」——**警告不阻断**，判断权给发布者，但留记录。
- **`deprecated` 状态**：标记弃用 + `superseded_by` 指向替代者。职责不清晰有一半是「旧的没人敢删」，给一个退休动作比审核便宜得多。装了 deprecated skill 的人在设置里看到提示。
- **不做管理员审核**。审核是人力承诺，现在没有那个人。等 registry 里内容多到真打架了再加——那时候审核的判断依据（when_to_use 冲突）也才存在。

## 7. frontmatter 回写（不做就前功尽弃）

**agent 读的是磁盘上的 SKILL.md，不是 Postgres。** registry 里字段再齐整，装到本地还是那坨 description，agent 眼里的职责照样不清晰。

安装时把结构化字段写回 frontmatter：

```yaml
---
name: deploy-check
description: 部署前检查清单        # 保留，老解析器仍能读
owner: 张三
category: devops
when_to_use: |
  发布前确认 CI 绿、迁移已跑、回滚方案就绪。
when_not_to_use: |
  不要用于本地开发环境；不要用于 hotfix 流程（走 hotfix-deploy）。
requires:
  - platform: any
  - mcp: none
version: 3
source: team
---
```

`name` 和 `description` 保留，保证向后兼容。

**随之而来的必做项：换掉两个正则解析器。**

- `packages/app/src/lib/git/skill-loader.ts` — TS 侧
- `apps/daemon/src/config/roles_skills.rs` — Rust 侧

`when_not_to_use` 这种多行值一进来，现有正则当场崩。**两边必须同时换**——只改一边的后果是桌面端显示正常、daemon 里 agent 拿到的是截断内容，而且很难查。

## 8. 客户端流程

复用 `clawhub.rs` 的内部函数，不重写：

```
team_skill_install(slug, version, scope)
  → GET  /v1/teams/:id/skills/:slug/versions/:v/download   拿签名 URL
  → 下载 zip
  → extract_zip_to_dir()          （已有，含路径穿越防护）
  → 回写 frontmatter               （新增）
  → write_skill_origin()          （已有，origin.json 加 source: "team" + teamId）
  → write_lockfile()              （已有，entry 加 source 字段）
  → 写 permission.skill            （已有）
  → PUT .../install                记录到服务端
```

lockfile 建议**和 ClawHub 共用** `.clawhub/lockfile.json`，entry 加 `source: "clawhub" | "team"`。理由：更新检查只跑一遍，用户看到的是一个统一的「有更新」列表。

### 8.1 团队共享 agent 的安装（管理员直接装）

对 `visibility='team'` 的 agent actor，管理员在市场里点安装，走的是**同一个 API、不同的 `actorId`**。区别在落盘和触发：

**谁执行落盘。** 管理员的机器上不一定跑着那个 agent。所以服务端只写 `team_skill_installs` 记录，**真正的落盘由承载该 agent 的 daemon 完成**：

```
管理员点安装
  → PUT /v1/teams/:id/skills/:slug/install  { actorId: <team agent>, version }
  → FC 写 install 记录
  → FC 经 MQTT 通知该 agent actor（topic: amux/<team_id>/<actor_id>/notify）
  → 承载它的 daemon 收到 → 拉取该 actor 的安装清单 → 下载解压 → 回写 frontmatter
```

MQTT 通道是现成的（`crates/teamclaw-types/src/mqtt.rs` 的 `actor_notify()`），不新造推送链路。

**落到哪个目录。** `agents.default_workspace_id` 对应的 workspace 的 `.teamclaw/skills/`。该字段为空时，落 daemon 的团队默认工作区 `~/.amuxd/teams/<team_id>/workspace`（`global_team_store.rs::default_workspace_dir`），这也是无 workspace 的运行时 spawn 已经在用的兜底。

**对账而非增量。** daemon 收到通知后拉的是**该 actor 当前应有的完整清单**，和本地 lockfile 做差集：多的装、少的卸、版本不符的换。理由是通知会丢、daemon 会离线，只处理增量迟早漂移。启动时也跑一次同样的对账。

**权威在服务端。** 和成员 actor 相反：team agent 的本地 lockfile 是服务端记录的投影，冲突时服务端赢。管理员在别的机器上卸载了某个 skill，下次对账就该消失。

**未决**：同一个 team agent 是否可能被多台设备同时承载。若可能，对账要按设备幂等（当前设计天然幂等，因为是全量对账），但「装在哪台」的语义要再确认——见 §10 待定 #5。

市场 UI 在 `SkillsMarketplace.tsx` 加一个「团队」tab，和现有的 ClawHub tab 并列。

## 9. 桌面端 UI

沿用现有的团队共享三列结构，**入口不变**，改的是数据源和第三列。

### 9.1 现状

| 位置 | 文件 | 现在是什么 |
|---|---|---|
| 左导航「Skills」行 | `sidebar/TeamShareNavSection.tsx:16` | `Sparkles` 图标 + 计数，点击设 `filter = { kind:'teamShare', section:'skills' }` |
| 第二列列表 | `sidebar/TeamShareListColumn.tsx` | 扫 `teamclaw-team/skills/` 目录出来的 `TeamSkillItem`（slug / name / invocationName / category），header 有搜索和「+ 去设置」两个图标按钮 |
| 第三列详情 | `teamshare/TeamShareDetailPane.tsx` | **43 行的 EmptyState 桩子，尚未实现** |

### 9.2 第二列：全量列表 + 安装态

**数据源换掉。**从「扫本地团队目录」改成 `GET /v1/teams/:id/skills` 的**全量 registry 列表**，每项带 `installed` / `installedVersion` / `hasUpdate`。本地 lockfile 参与合并，决定 `installed` 的最终显示（服务端记录允许漂移，见 §4）。

**行内安装态。**`ItemRow` 目前没有右侧插槽，需要加一个 `trailing`：

- 已安装 → `Check` 图标，muted 色
- 已安装且有新版 → `ArrowUpCircle`，coral 色
- 未安装 → 不显示（留白，避免整列图标噪音）
- 已弃用（`status='deprecated'`）→ 标题走 muted + 一个 `Archive` 角标

不要用现有的 `statusDot`——那是 MCP 的连接状态语义，混用会让两列的同一个视觉元素表示不同东西。

**header 加过滤按钮。**现在是 `Search` + `Plus` 两个 `h-7 w-7` 的 ghost 按钮，在它们左边插第三个：

- 图标 `ListFilter`，toggle 语义
- 激活时 `text-coral`，并把标题旁的计数从「全量」切成「已安装 / 全量」
- 状态只存组件内 `useState`，不落 store——它是瞬时视图偏好，不是需要持久化的东西

**计数语义变了。**现在 header 的 `· {count}` 是目录里的文件数，改成 registry 全量数。这会让数字明显变大，是预期行为。

**空状态文案要改。**现在是「Nothing shared with the team yet.」，全量列表下应该是「团队还没有人发布 skill」+ 一个「发布第一个」的行动点。

### 9.3 第三列：详情 + 安装 / 卸载

`TeamShareDetailPane.tsx` 从桩子实装。skills 分支渲染：

```
标题区    name + slug(mono) + status 徽标(published/deprecated)
元数据    owner · category · 当前版本 · 更新时间
正文      summary
          何时使用      ← when_to_use
          何时不要用    ← when_not_to_use      （视觉上和上一条并列，这是重点）
          依赖          ← requires（有才显示）
版本      版本列表 + changelog，可展开
操作      [安装] / [卸载] + 「安装到」选择器
```

**「何时不要用」必须和「何时使用」视觉并列**，不能折叠或降级成小字。§6 里让人填这个字段，是为了让两个重叠的 skill 能被并排比较——UI 上藏起来就白填了。

**「安装到」选择器**是管理员给团队 agent 装的落点（§8.1）：

- 默认项：我自己（当前 member actor）
- 其他项：调用者有权管理的 `visibility='team'` agent actor
- 只有一个可选项时不显示选择器，直接装给自己
- 装给 team agent 后，按钮区显示「已安装到 <agent 名>」，卸载同理

`deprecated` 的 skill：安装按钮降级为次要样式 + 一行提示「已弃用，建议改用 <superseded_by>」，点那个 slug 直接跳过去。**不禁用安装**——旧流程可能还依赖它。

### 9.4 过渡期的双来源

`skills/` 退出团队同步之前（§10 待定 #1），列表里会同时有 registry 项和遗留目录项。遗留项加一个「遗留」徽标 + 详情页顶部一条「这个 skill 还在旧的共享目录里，发布到市场后可获得版本管理」的行动条，点了走发布流程。

这是过渡期唯一允许的双来源显示，退役后整段删掉。

## 10. 待定问题

| # | 问题 | 倾向 |
|---|---|---|
| 1 | `teamclaw-team/skills/` 何时退出团队同步？三处镜像常量（daemon `SHARED_PREFIXES`、desktop `ALLOWED_PREFIXES`、FC `sync-path.ts`）+ 老客户端兼容 + 存量导入 | 存量一次性导入为 v1，退出同步排到 P2；过渡期把目录标为「遗留」并禁止 UI 新增写入 |
| 2 | 安装作用域：全局跟人走，还是 workspace 跟项目走 | 默认全局（`is_global=true`），高级选项允许装到 workspace |
| 3 | 撞名优先级：团队市场 / ClawHub / 本地手写，同名谁赢 | 沿用现有 `source_priority`，本地 > 团队 > ClawHub；被盖住的要**显式报告**而不是静默丢弃 |
| 4 | ~~管理员推送语义~~ | **已定**：管理员对 `visibility='team'` 的 agent actor 直接装，见 §4 / §5 / §8.1。成员的 member actor 仍是自助，管理员不能代装 |
| 5 | team agent actor 的 skill 落在哪台机器的哪个目录 | 见 §8.1，落 `agents.default_workspace_id` 对应 workspace；多设备承载同一 agent 的情况待确认 |
| 6 | YAML 解析器选型与替换节奏 | TS 侧和 Rust 侧同一个 PR 换掉，配一组两边对拍的 fixture |

## 11. 明确不做

- 成员间的可见性隔离 / ACL（表结构留扩展位，v1 不实现）
- 信封加密、per-skill 密钥
- 管理员发布审核
- 跨团队 / 组织级分发
- 在 registry 上做 skill 的在线编辑器

## 12. 分期

**P0 — 能用**
表 + 发布/列表/下载/安装 API + frontmatter 回写 + 两个 YAML 解析器 + 存量一次性导入
UI：第二列换成 registry 全量 + 行内安装态 + header 过滤（§9.2）、第三列详情实装 + 安装/卸载（§9.3）

**P1 — 能管**
deprecated + superseded_by、owner 转交、相似度警告、更新检查合流到统一列表
UI：「安装到」选择器（团队 agent）、遗留项徽标与迁移行动条（§9.4）

**P2 — 能收**
`skills/` 退出团队同步、安装记录的运营视图、多设备承载同一 team agent 的对账语义

> §8.1 的团队 agent 安装（管理员直接装 + MQTT 通知 + daemon 对账）排在 **P1**：它依赖 P0 的表和 API，但不依赖 P2 的任何东西，而且是「统一管理」这个目标的主要兑现点。

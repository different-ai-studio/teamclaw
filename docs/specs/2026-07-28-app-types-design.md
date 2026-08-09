# Apps 三种应用类型 — 设计

- **Date**: 2026-07-28
- **Status**: Design, 待评审
- **Scope**: 把 app 从单一「全栈」类型扩成三种（静态网页 / 演示材料 / 数据操作），
  三种都能部署到 FC 并有访问 URL，每个 app 播种时带一份 `AGENTS.md` 告诉 agent
  自己是什么、该怎么改。
- **前置**: 现有 apps 模块（建仓 → 播种 → 构建 → FC 部署 → live URL），见
  `2026-06-14-apps-module-phase2-design.md`。

---

## 1. 三种类型

| 显示名 | type id | 内容形态 | 需要 Postgres |
|---|---|---|---|
| 静态网页 | `static_web` | HTML/CSS/JS | 否 |
| 演示材料 | `slides` | HTML（分页幻灯片） | 否 |
| 数据操作 | `data_app` | TanStack Start SSR | 是 |

`data_app` 就是今天的 `fullstack_tanstack_postgres`。**不做数据迁移**：`apps.type`
是自由文本列（`db/schema/apps.ts` 里 `text("type").notNull()`，无 CHECK 约束），
旧值在一处 resolver 里当作 `data_app` 的别名认掉即可。

静态网页和演示材料在**运行时上完全同构**，差别只在模板内容和 `AGENTS.md`。之所以
仍然分成两个类型，是因为 agent 拿到的指令不同 —— 一个是「写页面」，一个是「写这一页
讲什么」，这直接决定 agent 的产出质量。类型也让列表和创建对话框讲得清楚。

---

## 2. 核心决策：一条部署流水线，三份模板

**产物契约不变**：`pnpm install --frozen-lockfile && pnpm build` 产出 `.output/`，
里面必须有 `server/index.mjs`，监听 `$PORT`。daemon 把 `.output` 的内容打成 zip 传
OSS，FC 用 custom runtime 跑 `node server/index.mjs`。

静态类型不是「不需要服务器」，而是**自带一个二十行的静态文件服务器**：

```js
// .output/server/index.mjs（由模板的 build 脚本产出）
import { createServer } from 'node:http'
import { stat, readFile } from 'node:fs/promises'
// serve ../public, index.html fallback, 正确的 content-type
createServer(/* ... */).listen(process.env.PORT || 9000)
```

这样 `app_build.rs`、`fc-client.ts` 的 `customRuntimeConfig`、OSS 交接、部署状态机、
`fc_endpoint` 回填 —— **一行都不用改**。

> 被否掉的方案：静态类型走 OSS 静态网站托管。会多出第二条部署路径、第二套失败模式，
> 而且访问 URL 的形态跟 `data_app` 不一致（域名不同、状态机对不上）。省下的那点冷启动
> 时间不值得。

静态模板即使零依赖也保留 `package.json` + 提交的 `pnpm-lock.yaml`（空锁文件），
这样 daemon 的 `--frozen-lockfile` 不需要为类型分支。

---

## 3. Postgres 只给数据操作

今天 `finalizeDeploy` 无条件调 `ensureAppSchema`。改成按类型：

```
data_app    → ensureAppSchema → 注入 DATABASE_URL
static_web  → 跳过，env 里没有 DATABASE_URL
slides      → 同上
```

顺带的好处：静态 app 的部署不再依赖 `APPS_DB_ADMIN_URL`。今天这个变量缺失会让
`makeDeployDeps()` 整体返回 `{}`、所有部署 503 —— 改完之后静态类型不受影响。
（对应地，`makeDeployDeps` 的「已配置」判定要拆成两级：FC 相关的是硬要求，
Postgres 相关的只有 `data_app` 需要。）

`finalizeDeploy` 需要知道类型 —— repo 层已经加载了 app 行，把 `type` 一起传给
provisioning 即可，无新增查询。

---

## 4. AGENTS.md：每个 app 一份

opencode 原生读取工作区根目录的 `AGENTS.md`，所以放在 app 仓库根目录即可，不需要
daemon 做额外注入。

**来源**：每个模板仓库提交一份 `AGENTS.md`，daemon 播种时替换占位符：

| 占位符 | 值 |
|---|---|
| `{{APP_NAME}}` | app 名称 |
| `{{APP_TYPE}}` | 类型显示名（静态网页 / 演示材料 / 数据操作） |
| `{{APP_ID}}` | app id |

替换发生在 `app_seed.rs` 的「写模板 → 首次提交」之间，是纯文本替换，不引入模板引擎。

**每份 AGENTS.md 必须讲清四件事**（这是内容规范，不是可选项）：

1. **这是什么** —— 「你在维护一个叫 {{APP_NAME}} 的{{APP_TYPE}}。」
2. **内容放哪** —— 静态/演示：`public/`；数据操作：`src/` + `db/`。
3. **什么不能动** —— 构建产物契约：`pnpm build` 必须产出 `.output/server/index.mjs`
   且监听 `$PORT`。改坏这个，app 就部署不上去。锁文件是故意提交并锁死版本的
   （见 `0c108cd3` 的教训：caret range 让上游一次发布打挂了所有 app 构建）。
4. **怎么上线** —— 用户在 TeamClu 里点「部署」；agent 不需要、也不能自己部署。
   数据操作类还要说明：数据库连接串由平台通过 `DATABASE_URL` 注入，schema 是
   app 私有的，迁移在冷启动时自执行。

---

## 5. 去掉远程仓：本地 git + 内嵌模板

**决定**：app 不再有远程仓库。播种时 `git init` + 首次提交，不建 Codeup 仓、不 push。

理由：部署路径本来就不碰 git —— `build_artifact` 在 `~/.amuxd/apps/<appId>` 里直接
`pnpm build`，不 fetch 不 checkout。git 此前只用于「建仓」和「clone 模板再 push」，
而这两步各自拖着一条失败路径（`CODEUP_*` 缺失、网络、PAT）。保留**本地** git 则留下
了 agent 改坏文件后的回滚能力，成本只有几行。以后要加远程，`git remote add` + push
即可，没有需要回退的东西。

代价：app 源码只在建它的那台机器上 —— 无异地备份、换机器拿不到、团队不可见。

**模板改为内嵌**：既然不 clone，模板就得在本地。三份模板放回本仓库 `templates/`，
用 `include_dir!` 编进 amuxd 二进制。这同时解决了 `a673d76d` 删除旧副本时指出的漂移
问题（那份副本没有任何代码读它，靠手工与上游同步）—— 现在是唯一来源，可评审、CI 可
直接 smoke build。代价是改模板要发 daemon 版本；考虑到 `0c108cd3` 的锁文件教训，
模板与 daemon 一起走版本反而更安全。

```
templates/static-web/
templates/slides/
templates/tanstack-postgres/
```

三份模板之间会有重复（静态服务器、构建脚本），这是刻意的 —— 每份保持可独立
`pnpm install && pnpm build` 比抽公共包更重要。

### 5.1 生命周期简化

`provision_status` 从 `pending → repo_created → seeding → ready` 塌成：

```
pending → ready      （播种成功）
pending → error      （播种失败，可重试）
```

- `createApp` 不再调 `provisionAppRepo`，插入行后直接返回 `pending`。
- `git_remote_url` / `git_auth_kind` 对新 app 恒为 null；列仍保留，旧 app 的值照读。
- `repo_created` / `seeding` 在 `app-status.ts` 里保留为合法来源状态（旧行还停在
  那儿），但不再是新 app 会经过的状态。
- `POST /v1/apps/seed` 的 body：`gitRemoteUrl` 与 `gitToken` 变为可选（旧路径仍可
  用），新增 `appType`。

`/v1/teams/:id/managed-git-credential` 端点保留 —— 它服务的是 team-share，不是 apps。

---

## 6. 演示材料：reveal.js

reveal.js vendored 进模板的 `public/vendor/`，不走 CDN —— FC 出网不确定，且要保证
构建确定性。`AGENTS.md` 里规定「一个 `<section>` 就是一页」，agent 只需要往
`public/index.html` 里加 section，不需要理解 reveal 的初始化。

---

## 7. 改动落点

| 文件 | 改动 |
|---|---|
| `templates/{static-web,slides,tanstack-postgres}/`（新） | 三份模板 + 各自 `AGENTS.md` |
| `packages/app/src/lib/app-types.ts`（新） | type id ↔ 显示名/描述，legacy 别名 |
| `packages/app/src/components/apps/CreateAppDialog.tsx` | 类型选择器（3 张卡片），替换写死的 `APP_TYPE` |
| `packages/app/src/stores/apps-store.ts` | `runSeed` 带 appType、不再要求 gitRemoteUrl |
| `packages/app/src/lib/daemon-local-client.ts` | `seedDaemonApp` 签名 |
| `packages/app/src/components/sidebar/AppsListColumn.tsx` | 行上显示类型；reseed 门槛 |
| `apps/daemon/Cargo.toml` | 新增 `include_dir` |
| `apps/daemon/src/sync/app_templates.rs`（新） | 内嵌模板 + 按类型取 + 占位符替换 |
| `apps/daemon/src/sync/app_seed.rs` | 写文件 + `git init` + commit，删掉 clone/push/凭证 |
| `apps/daemon/src/http/apps.rs` | seed body 加 `appType`，`gitRemoteUrl` 转可选 |
| `services/fc/src/lib/pg-repo/apps.ts` + `supabase-repo.ts` | createApp 不再建仓；把 `type` 传给 finalize |
| `services/fc/src/lib/pg-repo/app-status.ts` | `pending → ready/error` |
| `services/fc/src/lib/provisioning/app-deploy.ts` | `finalizeDeploy` 按类型决定是否 provision schema |
| `services/fc/src/index.ts` | `makeDeployDeps` 配置判定拆两级；不再注入 `provisionAppRepo` |
| `docs/openapi/teamclu-api.v1.yaml` | `type` 的 enum + 说明 |

数据库：**无迁移**。

---

## 8. 测试

- `app-deploy`：`data_app` 走 schema provisioning、静态类型不走（mock adminExec，
  断言调用次数为 0）。
- `template_repo_url(type)`：三种类型 + 环境变量覆盖 + 未知类型的回退。
- `app_seed`：占位符替换后 `AGENTS.md` 不含 `{{`。
- 三个模板各一条 CI smoke：`pnpm install --frozen-lockfile && pnpm build` 之后
  `.output/server/index.mjs` 存在，且 `PORT=xxxx node` 起来能 200。
  （这条最重要 —— 产物契约是所有类型共享的唯一硬约束。）
- 桌面：创建对话框类型选择 + 列表显示。

---

## 9. 明确不做

- 类型之间的转换（建完不能改类型）。
- 静态类型的自定义域名 —— 仍用 FC 默认 HTTP 触发 URL。
- 本地预览（三种类型都还是「即将推出」）。
- 演示材料的导出（PDF/PPTX）。
- 模板之间抽公共包。

---

## 10. 已确认的决定

1. 演示材料用 **reveal.js**（vendored，不走 CDN）。
2. type id 用 **`data_app`**，`fullstack_tanstack_postgres` 作为旧值别名。
3. 静态类型**也各占一个 FC 函数**，保持流水线统一。若将来 app 数量很大，可另设计
   「静态类型共享一个函数按路径分发」。
4. **不建远程仓**，本地 git + 内嵌模板（§5）。

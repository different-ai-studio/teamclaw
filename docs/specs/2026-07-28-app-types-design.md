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
4. **怎么上线** —— 用户在 TeamClaw 里点「部署」；agent 不需要、也不能自己部署。
   数据操作类还要说明：数据库连接串由平台通过 `DATABASE_URL` 注入，schema 是
   app 私有的，迁移在冷启动时自执行。

---

## 5. 模板仓库

今天是一个 GitHub 模板仓库，由 `TEAMCLAW_APP_TEMPLATE_URL` 覆盖。三种类型需要三个：

```
different-ai-studio/template-static-web
different-ai-studio/template-slides
different-ai-studio/template-tanstack-postgres   ← 已存在
```

`template_repo_url()` 改成按类型取，环境变量覆盖也按类型分：
`TEAMCLAW_APP_TEMPLATE_URL_STATIC_WEB` 等。

`POST /v1/apps/seed` 的 body 需要新增 `appType` 字段（daemon 据此选模板 + 做占位符
替换）。桌面端在 `runSeed` 里带上。

> 提醒：`templates/` 目录已在 `a673d76d` 删除，模板只存在于上游仓库。三个模板仓库
> 之间会有重复（静态服务器、构建脚本），这是刻意的 —— 让每个模板保持可独立 clone
> 即跑，比抽公共包更重要。

---

## 6. 演示材料用什么

三个选项：

1. **reveal.js 内联进模板**（推荐）—— 成熟、键盘导航/演讲者视图都有，agent 对它
   的 HTML 结构很熟。依赖 vendored 进 `public/`，不走 CDN（FC 出网不确定，且要
   保证构建确定性）。
2. **纯 HTML + CSS scroll-snap** —— 零依赖，但翻页/演讲者视图要自己写。
3. **Markdown → HTML 构建** —— agent 写 Markdown 最自然，但多一层构建，且
   排版控制力弱。

推荐 1；如果更看重「agent 写起来简单」，可以用 1 的骨架 + AGENTS.md 里规定
「一个 `<section>` 就是一页」。**这条需要你拍板。**

---

## 7. 改动落点

| 文件 | 改动 |
|---|---|
| `packages/app/src/components/apps/CreateAppDialog.tsx` | 类型选择器（3 张卡片），替换写死的 `APP_TYPE` |
| `packages/app/src/lib/app-types.ts`（新） | type id ↔ 显示名/图标/描述，legacy 别名 |
| `packages/app/src/stores/apps-store.ts` | `runSeed` 带上 appType |
| `packages/app/src/components/sidebar/AppsListColumn.tsx` | 行上显示类型 |
| `apps/daemon/src/http/apps.rs` | seed body 加 `appType`；`template_repo_url(type)` |
| `apps/daemon/src/sync/app_seed.rs` | 占位符替换 |
| `services/fc/src/lib/provisioning/app-deploy.ts` | `finalizeDeploy` 按类型决定是否 provision schema |
| `services/fc/src/lib/pg-repo/apps.ts` + `supabase-repo.ts` | 把 `type` 传给 finalize |
| `services/fc/src/index.ts` | `makeDeployDeps` 的配置判定拆两级 |
| `docs/openapi/teamclaw-api.v1.yaml` | `type` 的 enum + 说明 |
| 三个模板仓库 | 静态服务器 + build 脚本 + `AGENTS.md` |

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

## 10. 待你确认

1. **演示材料的框架**（§6）—— reveal.js 还是更简的方案。
2. **type id 命名** —— `data_app` 还是保留 `fullstack_tanstack_postgres` 作为
   正式 id。我倾向前者 + 后者当别名，读起来跟另外两个平级。
3. **静态类型是否也占一个 FC 函数** —— 本设计是「是」（保持流水线统一）。如果
   app 数量会很大，可以考虑静态类型共享一个函数按路径分发，但那是另一套设计。

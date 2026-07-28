# {{APP_NAME}}

你在维护一个叫 **{{APP_NAME}}** 的**数据操作**应用（app id `{{APP_ID}}`）。
它是一个 TanStack Start 全栈应用，带一个属于自己的 Postgres schema。

## 内容放哪

- `src/routes/` — 页面与路由（TanStack Router 的文件式路由）
- `src/db.ts` — 数据库连接
- `db/schema.sql` — 建表语句；首次部署冷启动时对本 app 自己的 schema 执行

## 数据库

连接串由平台通过环境变量 **`DATABASE_URL`** 注入，**不要写死、不要提交任何连接串或
密码**。这个角色只能访问本 app 自己的 schema，`search_path` 已经固定好了 ——
正常写 `select * from your_table` 即可，不需要也不应该加 schema 前缀。

每次部署平台都会轮换这个角色的密码并同步更新环境变量，所以本地跑不通、线上跑得通
是正常的。

## 不要动的东西

- **构建产物契约** —— `pnpm build` 必须产出 `.output/server/index.mjs` 且监听
  `$PORT`。这是平台部署这个 app 的唯一契约，改坏了就传不上去。
- **`pnpm-lock.yaml`** —— 故意提交并锁死精确版本。构建用
  `pnpm install --frozen-lockfile`。曾经 `@tanstack/react-start` 用的是 caret 范围，
  上游发了一版删掉了模板引用的入口，所有 app 的构建当场全挂。加依赖时也请写精确版本
  并更新锁文件。

## 怎么上线

用户在 TeamClaw 的应用列表里点「部署」。你不需要、也没有权限自己部署 ——
改好代码即可。

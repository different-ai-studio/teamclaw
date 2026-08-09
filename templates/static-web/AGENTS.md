# {{APP_NAME}}

你在维护一个叫 **{{APP_NAME}}** 的**静态网页**应用（app id `{{APP_ID}}`）。

## 内容放哪

网站的全部内容在 `public/`：

- `public/index.html` — 首页
- `public/styles.css` — 样式
- 想加页面就在 `public/` 下加 `.html`，想加图片/字体也放这里

`public/` 下的东西按原路径提供服务：`public/about.html` → `/about.html`，
目录会回落到该目录的 `index.html`，找不到的路径回落到首页。

## 不要动的东西

- **`server.mjs` 和 `build.mjs`** —— 它们保证 `pnpm build` 产出
  `.output/server/index.mjs` 且监听 `$PORT`。这是平台部署这个 app 的唯一契约，
  改坏了就传不上去。要加功能请改 `public/`，不要改服务器。
- **`pnpm-lock.yaml`** —— 故意提交并锁死版本。构建时用的是
  `pnpm install --frozen-lockfile`；曾经有一次依赖用了 caret 范围，上游发了个新版本
  就把所有 app 的构建打挂了。

## 怎么上线

用户在 TeamClu 的应用列表里点「部署」。你不需要、也没有权限自己部署 ——
把文件改好就行，剩下的交给用户。

想在本地看效果：`pnpm dev`，然后打开 `http://localhost:9000`。

## 没有数据库

这是纯静态应用，没有后端、没有数据库。如果用户要的功能需要存数据，
告诉他们应该建一个「数据操作」类型的应用。

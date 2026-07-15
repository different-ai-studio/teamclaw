# 编译期按品牌生成主题配色(per-brand palette)

**日期**: 2026-06-12
**分支**: `task/wo-xiang-zi-ding-yi-ming-cheng-helogo`(接着白标 name+logo 一起做)
**状态**: 设计已确认,待写实现计划

## 目标

把**品牌**和**配色**绑定:每个品牌在 `branding/<brand>/` 里放一份手写的主题
token 表(`theme.json`),构建时自动产出 `:root[data-palette="<brand>"]{…}` 的
CSS 并注入构建——不用再手改 `globals.css`。一个 `BUILD_ENV=<brand>` 同时出
**名称 + logo + 配色**。

**约束**:默认 / 生产 / 现有 `teal` 构建产物**零差异**(无 theme.json 的 palette
不生成)。

## 背景:现状

- 配色机制:`app.palette`(build.config,编译期)→ 首帧脚本把它写成
  `<html data-palette="…">`(`packages/app/index.html`、`packages/app/src/main.tsx`)
  → `globals.css` 里 `:root[data-palette="teal"]{…}` 这类**手写**块按特异性生效。
- 现有 palette:`default`(Editorial Calm,明+暗)、`teal`(阳极蓝绿,**仅亮色**,
  靠 `:root[data-palette]` 特异性 (0,1,1) 压过 `.dark` (0,1,0))。teal 块约 36 个
  token,可只覆盖子集(`--destructive`、`--chart-*` 继承 default)。
- 白标 name+logo 已落地(本分支):`branding/<brand>/logo.png` + `build.config`
  的 `app.name`/`app.logo`。本特性复用同一个 `branding/<brand>/` 文件夹。
- `packages/app/vite.config.ts` 已读合并后的 build.config,并通过 `transformIndexHtml`
  往 `index.html` 注入 `__APP_SHORT_NAME__` / `__PALETTE__` 占位符。这是天然挂载点。

## 决策(已与用户确认)

1. **palette id 约定 = 品牌文件夹名**:`app.palette: "acme"` ↔ `branding/acme/theme.json`。
   不引入独立的 `app.theme` 指针。
2. **theme.json 只覆盖子集**,未写的 token 继承 default `:root`(CSS 级联)。
3. **未知 token 名 → fail build**(不静默忽略)。
4. **仅亮色**(和 teal 一致,不做 dark 变体)。
5. 配色源 = **手写完整 token**(无取色 / 派生算法)。

## 方案选型(生成的 CSS 怎么接进构建)

- **A(采纳)vite 插件 + `<style>` 注入**:`vite.config.ts` 里读
  `branding/<palette>/theme.json`,拼出 `:root[data-palette="<brand>"]{…}`,经
  `transformIndexHtml` 注入 `<head>`。首帧无闪烁、**web 与 tauri 构建都生效**、
  复用现有 `data-palette` 注入、`globals.css` 零改。
- B prebuild 写 generated.css 让 `globals.css` `@import`:生成文件要 gitignore +
  静态 import,跨构建协调更绕。**否决**。
- C 继续手改 `globals.css`:即现状,用户要摆脱的。**否决**。

## 设计

### 1. 品牌主题文件 `branding/<brand>/theme.json`(仅亮色)

```jsonc
{
  "tokens": {
    "--primary": "#0f6e62",
    "--system-accent": "#16998a",
    "--coral": "#16998a",
    "--background": "#f2f0ea",
    "--foreground": "#20242a"
    // 只写要覆盖的,其余继承 default :root
  }
}
```

### 2. 纯生成器 `scripts/lib/brand-theme.js`(CommonJS,可单测)

与白标的 `scripts/lib/branding.js` 同一套路,被 `pnpm test:scripts` 门控。导出:

- `extractRootTokenNames(globalsCss) -> Set<string>`
  解析 `globals.css` 里**第一个**顶层 `:root { … }` 块,提取其中声明的
  `--xxx` 变量名集合,作为合法 token 白名单(单一来源,防漂移)。
- `resolveBrandTheme(buildConfig, repoRoot) -> { palette, tokens } | null`
  取 `buildConfig.app.palette` = V;若 V 为空 / 为 `default` / 为 `teal`(保留给
  静态块)/ `branding/V/theme.json` 不存在 → 返回 `null`;否则读该 JSON,返回
  `{ palette: V, tokens }`。
- `generateBrandThemeCss(palette, tokens, allowedTokens) -> string`
  校验:每个 key 必须以 `--` 开头且 ∈ `allowedTokens`(否则 `throw` 列出未知
  key);每个 value 必须非空且不含 `;`、`{`、`}`(防止 CSS 注入 / 破坏,
  否则 `throw`)。返回单条规则字符串:
  `:root[data-palette="<palette>"]{--a:va;--b:vb;}`。

### 3. vite 插件接线(`packages/app/vite.config.ts`)

- 读合并后的 `buildConfig`(已有)。
- `const theme = resolveBrandTheme(buildConfig, repoRoot)`。
- 若 `theme`:读 `packages/app/src/styles/globals.css` → `extractRootTokenNames` →
  `generateBrandThemeCss(...)`(任意 `throw` 直接让构建失败,带清晰报错)。
- 在 `transformIndexHtml` 里把生成的 CSS 包成
  `<style id="brand-theme">…</style>` 注入 `<head>`(放在设置 `data-palette`
  的首帧脚本之后);无 theme 时注入空串。沿用现有 `__PALETTE__` 占位符替换法:
  在 `index.html` `<head>` 加一个占位标记(如 `<!--BRAND_THEME-->`),插件替换为
  `<style>` 块或空字符串。
- 特异性:`:root[data-palette="X"]` (0,1,1) 压过 `:root`(0,1,0)与 `.dark`
  (0,1,0),所以明暗切换都停在品牌亮色面,和 teal 行为一致。品牌 id 不等于
  `default`/`teal`,与静态块无冲突。

### 4. 不动 default / teal

无 `branding/<id>/theme.json` 的 palette,插件 no-op。teal 静态块 + 注释原样保留,
**零回归**。

### 5. 示例 & 文档

- 在 `branding/README.md` 补一段:`theme.json` 约定 + 「合法 token 取自 globals.css
  的 `:root`」+ 一个最小示例。
- 提供一个最小示例品牌主题(随手动冒烟用,不必进生产配置)。
- **不迁移 teal**(已发布、手调、带注释,迁移有回归风险);作为可选 follow-up。

## 副作用

品牌构建会往 `index.html` 注入一个 `<style>`(产物内,不落 git;`index.html` 是
模板,`transformIndexHtml` 只改产物不改源文件)。默认 / teal 构建注入空串 → 源文件
与产物无品牌差异。结合白标既有副作用(图标 / logo 就地覆盖)一并在 PR 说明。

## 测试

- `scripts/lib/brand-theme.test.js`(`node --test`,进 `test:scripts` 即 CI 门控):
  - `extractRootTokenNames`:能从一段 `:root{--a:1;--b:2;}` 提取 `{--a,--b}`,
    且不误纳 `.dark{…}` 或 `:root[data-palette=…]{…}` 里的变量。
  - `resolveBrandTheme`:palette 空 / default / teal / 文件缺失 → null;存在 →
    返回 `{palette, tokens}`。
  - `generateBrandThemeCss`:正常生成单条规则;未知 token key → throw;
    值含 `;`/`}` → throw;子集只产出所给 token。
- 手动:造 `branding/acme/theme.json` + `build.config.acme.json`(palette:"acme"),
  `BUILD_ENV=acme pnpm dev` 看配色生效;`BUILD_ENV=acme pnpm build` 产物 head 含
  注入的 `<style id="brand-theme">`;清理不留脏。
- 默认零差异:`pnpm build`(无品牌)产物不含 brand-theme style(或为空)。

## 不做(YAGNI)

- 取色 / 从 logo 派生主色 —— 排除(用户选手写 token)。
- dark 变体 —— 排除(仅亮色)。
- 运行时切换品牌主题 —— 排除(编译期)。
- 迁移现有 teal 到 theme.json —— 可选 follow-up,本次不做。
- token 值的语义校验(对比度 / 颜色格式) —— 仅做防 CSS 破坏的字符校验,不验色值合法性。

# 编译期按品牌生成主题配色 — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让每个品牌在 `branding/<brand>/theme.json` 手写一份 light-only 主题 token 表,构建时自动生成 `:root[data-palette="<brand>"]{…}` 并注入 `index.html`,靠现有 `app.palette` 机制选用;默认/`teal`/`default` 构建零差异。

**Architecture:** 纯生成器放 `scripts/lib/brand-theme.js`(CJS,被 `pnpm test:scripts` 即 CI 门控,与白标的 `branding.js` 同套路):`extractRootTokenNames`(从 globals.css 的 `:root{}` 取合法 token 白名单)、`resolveBrandTheme`(读 `branding/<palette>/theme.json`)、`generateBrandThemeCss`(校验+拼 CSS,未知 token/危险值直接 throw 让构建失败)。`packages/app/vite.config.ts` 在加载期算出 `<style>` 字符串,经已有的 `transformIndexHtml` 用 `__BRAND_THEME__` 占位符注入 `index.html` `<head>`。

**Tech Stack:** Node(CJS + `node --test`)、Vite `transformIndexHtml`、CSS 自定义属性(靠 `:root[data-palette]` 特异性压过 `.dark`)。

**Spec:** `docs/specs/2026-06-12-per-brand-theme-palette-design.md`

---

## File Structure

- `scripts/lib/brand-theme.js` — **新建**。三个纯函数,无副作用(除 `resolveBrandTheme` 读 theme.json)。
- `scripts/lib/brand-theme.test.js` — **新建**。`node --test`。
- `packages/app/vite.config.ts` — **改**。import 生成器;加载期算 `brandThemeStyle`;`transformIndexHtml` 加 `__BRAND_THEME__` 替换。
- `packages/app/index.html` — **改**。`</head>` 前加 `__BRAND_THEME__` 占位符。
- `branding/README.md` — **改**。补 theme.json 约定 + token 来源说明 + 最小示例。

---

## Task 1: 纯生成器 `brand-theme.js` + 单测

**Files:**
- Create: `scripts/lib/brand-theme.js`
- Create: `scripts/lib/brand-theme.test.js`

- [ ] **Step 1: 写失败测试**

新建 `scripts/lib/brand-theme.test.js`:

```js
"use strict";
const test = require("node:test");
const assert = require("node:assert");
const {
  extractRootTokenNames,
  generateBrandThemeCss,
  resolveBrandTheme,
} = require("./brand-theme");

const SAMPLE_CSS = `
:root {
  --background: #fff;
  --primary: #111;
}
.dark {
  --background: #000;
  --only-in-dark: #abc;
}
:root[data-palette="teal"] {
  --only-in-teal: #0f6e62;
}
`;

test("extractRootTokenNames returns only the bare :root block tokens", () => {
  const names = extractRootTokenNames(SAMPLE_CSS);
  assert.ok(names.has("--background"));
  assert.ok(names.has("--primary"));
  assert.ok(!names.has("--only-in-dark"));
  assert.ok(!names.has("--only-in-teal"));
  assert.strictEqual(names.size, 2);
});

test("generateBrandThemeCss emits one rule for the given palette + tokens", () => {
  const allowed = new Set(["--primary", "--background"]);
  const css = generateBrandThemeCss("acme", { "--primary": "#0f6e62" }, allowed);
  assert.strictEqual(css, ':root[data-palette="acme"]{--primary:#0f6e62;}');
});

test("generateBrandThemeCss throws on an unknown token name", () => {
  const allowed = new Set(["--primary"]);
  assert.throws(
    () => generateBrandThemeCss("acme", { "--bogus": "#000" }, allowed),
    /unknown.*--bogus/i
  );
});

test("generateBrandThemeCss throws on a non --token key", () => {
  const allowed = new Set(["--primary"]);
  assert.throws(
    () => generateBrandThemeCss("acme", { primary: "#000" }, allowed),
    /unknown.*primary/i
  );
});

test("generateBrandThemeCss throws on a dangerous value", () => {
  const allowed = new Set(["--primary"]);
  assert.throws(
    () => generateBrandThemeCss("acme", { "--primary": "#000;}body{x" }, allowed),
    /invalid.*--primary/i
  );
});

test("resolveBrandTheme returns null for default/teal/empty palettes", () => {
  assert.strictEqual(resolveBrandTheme({ app: {} }, "/repo"), null);
  assert.strictEqual(resolveBrandTheme({ app: { palette: "default" } }, "/repo"), null);
  assert.strictEqual(resolveBrandTheme({ app: { palette: "teal" } }, "/repo"), null);
});

test("resolveBrandTheme returns null when theme.json is missing", () => {
  assert.strictEqual(
    resolveBrandTheme({ app: { palette: "nope-no-such-brand" } }, "/repo"),
    null
  );
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test scripts/lib/brand-theme.test.js`
Expected: FAIL — `Cannot find module './brand-theme'`.

- [ ] **Step 3: 写实现**

新建 `scripts/lib/brand-theme.js`:

```js
"use strict";

const fs = require("fs");
const path = require("path");

/**
 * Extract the CSS custom-property names declared in the bare top-level
 * `:root { … }` block of a stylesheet (NOT `.dark` or `:root[data-palette=…]`).
 * Used as the allow-list of valid brand-theme token names (single source of
 * truth so theme.json keys can't drift from the real palette tokens).
 */
function extractRootTokenNames(css) {
  // `:root` followed (after optional whitespace) directly by `{` — excludes
  // `:root[data-palette="…"]` (next char is `[`). Capture up to the first `}`.
  const match = css.match(/:root(?!\[)\s*\{([^}]*)\}/);
  const names = new Set();
  if (!match) return names;
  const decls = match[1].matchAll(/(--[a-zA-Z0-9-]+)\s*:/g);
  for (const d of decls) names.add(d[1]);
  return names;
}

/**
 * Validate brand tokens against the allow-list and produce a single CSS rule
 * `:root[data-palette="<palette>"]{…}`. Throws (to fail the build) on an
 * unknown token name or a value containing CSS-breaking characters.
 */
function generateBrandThemeCss(palette, tokens, allowedTokens) {
  const entries = Object.entries(tokens || {});
  const unknown = entries
    .map(([k]) => k)
    .filter((k) => !k.startsWith("--") || !allowedTokens.has(k));
  if (unknown.length) {
    throw new Error(`brand theme: unknown token name(s): ${unknown.join(", ")}`);
  }
  const invalid = entries
    .filter(([, v]) => typeof v !== "string" || v.trim() === "" || /[;{}]/.test(v))
    .map(([k]) => k);
  if (invalid.length) {
    throw new Error(`brand theme: invalid token value(s): ${invalid.join(", ")}`);
  }
  const body = entries.map(([k, v]) => `${k}:${v};`).join("");
  return `:root[data-palette="${palette}"]{${body}}`;
}

/**
 * Resolve the brand theme for the configured palette. Returns null when there
 * is nothing to generate (no palette, the built-in `default`/`teal` flavors,
 * or no theme.json on disk). Throws if a present theme.json is malformed.
 */
function resolveBrandTheme(buildConfig, repoRoot) {
  const palette = buildConfig && buildConfig.app && buildConfig.app.palette;
  if (!palette || palette === "default" || palette === "teal") return null;
  const themePath = path.join(repoRoot, "branding", palette, "theme.json");
  if (!fs.existsSync(themePath)) return null;
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(themePath, "utf8"));
  } catch (e) {
    throw new Error(`brand theme: ${themePath} is not valid JSON: ${e.message}`);
  }
  if (!parsed.tokens || typeof parsed.tokens !== "object" || Array.isArray(parsed.tokens)) {
    throw new Error(`brand theme: ${themePath} must have a "tokens" object`);
  }
  return { palette, tokens: parsed.tokens };
}

module.exports = { extractRootTokenNames, generateBrandThemeCss, resolveBrandTheme };
```

- [ ] **Step 4: 跑测试确认通过**

Run: `node --test scripts/lib/brand-theme.test.js`
Expected: PASS（7 个用例全过）

- [ ] **Step 5: `test:scripts` 也覆盖到(沿用白标加的 glob)**

Run: `pnpm test:scripts`
Expected: PASS — 应同时包含 `branding.test.js`(6)与 `brand-theme.test.js`(7),共 13 个通过。

- [ ] **Step 6: Commit**

```bash
git add scripts/lib/brand-theme.js scripts/lib/brand-theme.test.js
git commit -m "feat(whitelabel): brand theme CSS generator (token allow-list + validation)"
```

---

## Task 2: vite 插件接线 + index.html 占位符

**Files:**
- Modify: `packages/app/index.html`(`</head>` 前)
- Modify: `packages/app/vite.config.ts`

- [ ] **Step 1: 在 index.html 加占位符**

在 `packages/app/index.html` 中,找到调色脚本结尾后的这两行(约 141-143):

```html
      })();
    </script>
  </head>
```

在 `</script>` 与 `</head>` 之间插入一行占位符,改成:

```html
      })();
    </script>
    __BRAND_THEME__
  </head>
```

- [ ] **Step 2: 在 vite.config.ts import 生成器并算出注入字符串**

在 `packages/app/vite.config.ts` 顶部 import 区(`import path from 'path'` 之后)加:

```ts
import {
  resolveBrandTheme,
  generateBrandThemeCss,
  extractRootTokenNames,
} from '../../scripts/lib/brand-theme.js'
```

注:`brand-theme.js` 是 CommonJS,esbuild 会从 `module.exports` 合成具名导出,vite config 里可直接具名 import。若 esbuild 报具名导出找不到,改用默认导入再解构:
`import brandTheme from '../../scripts/lib/brand-theme.js'` 然后
`const { resolveBrandTheme, generateBrandThemeCss, extractRootTokenNames } = brandTheme`。

在 `app.shortName` 校验块(`throw new Error(\`app.shortName must be …\`)` 那段)之后、`export default defineConfig({` 之前,加:

```ts
// --- Per-brand theme palette: generate a :root[data-palette="<brand>"] block ---
let brandThemeStyle = ''
const brandTheme = resolveBrandTheme(buildConfig as any, rootDir)
if (brandTheme) {
  const globalsCss = readFileSync(
    path.resolve(__dirname, 'src/styles/globals.css'),
    'utf-8'
  )
  const allowed = extractRootTokenNames(globalsCss)
  const block = generateBrandThemeCss(brandTheme.palette, brandTheme.tokens, allowed)
  brandThemeStyle = `<style id="brand-theme">${block}</style>`
}
```

（任何校验失败会在此处 `throw`,直接让构建失败并报清晰错误。`readFileSync` 已在文件顶部 import。）

- [ ] **Step 3: 在 transformIndexHtml 注入**

在 `inject-app-short-name` 插件的 `transformIndexHtml(html)` 里,把现有的 replace 链补一段。改成:

```ts
      transformIndexHtml(html) {
        const palette = ((buildConfig as any).app?.palette as string) || 'default'
        return html
          .replace(/__APP_SHORT_NAME__/g, sn as string)
          .replace(/__PALETTE__/g, palette)
          .replace(/__BRAND_THEME__/g, brandThemeStyle)
      },
```

- [ ] **Step 4: 冒烟——默认构建不注入品牌 style**

Run:
```bash
pnpm --filter @teamclaw/app build >/dev/null 2>&1 && grep -c 'id="brand-theme"' packages/app/dist/index.html
```
Expected: `0`（默认无 palette/theme.json → `__BRAND_THEME__` 替换为空串;`index.html` 产物里无 brand-theme;`__BRAND_THEME__` 字样也不残留）。
另外确认占位符没漏替换:
```bash
grep -c '__BRAND_THEME__' packages/app/dist/index.html
```
Expected: `0`。
清理:`rm -rf packages/app/dist`(若该目录非预期产物则 `git checkout -- packages/app/dist` 不适用,dist 默认 gitignore,直接删即可)。

- [ ] **Step 5: 冒烟——品牌构建真的注入对应配色**

```bash
mkdir -p branding/acme
cat > branding/acme/theme.json <<'JSON'
{ "tokens": { "--primary": "#0f6e62", "--background": "#f2f0ea" } }
JSON
cat > build.config.local.json <<'JSON'
{ "app": { "palette": "acme" } }
JSON
pnpm --filter @teamclaw/app build >/dev/null 2>&1
echo "--- injected style ---"
grep -o '<style id="brand-theme">[^<]*</style>' packages/app/dist/index.html
# 清理,务必不留脏
rm -rf branding/acme build.config.local.json packages/app/dist
git status --porcelain
```
Expected: 输出包含
`<style id="brand-theme">:root[data-palette="acme"]{--primary:#0f6e62;--background:#f2f0ea;}</style>`;
清理后 `git status --porcelain` 为空。

- [ ] **Step 6: typecheck**

Run: `pnpm typecheck`
Expected: 无新错误(已知预存 `src/App.tsx:91 scheduleSessionListRefresh` 可接受)。若 import 的 CJS 具名导出报 TS 类型错,按 Step 2 的默认导入回退法处理。

- [ ] **Step 7: Commit**

```bash
git add packages/app/index.html packages/app/vite.config.ts
git commit -m "feat(whitelabel): inject per-brand theme palette via vite transformIndexHtml"
```

---

## Task 3: 文档 + 约定

**Files:**
- Modify: `branding/README.md`

- [ ] **Step 1: 在 README 补主题约定段**

在 `branding/README.md` 末尾追加:

````markdown

## 品牌主题配色(可选,仅亮色)

在 `branding/<brand>/theme.json` 手写一份要覆盖的配色 token,并把对应
`build.config.<brand>.json` 的 `app.palette` 设成品牌文件夹名:

```jsonc
// branding/acme/theme.json — 只写要覆盖的 token,其余继承默认主题
{
  "tokens": {
    "--primary": "#0f6e62",
    "--system-accent": "#16998a",
    "--coral": "#16998a",
    "--background": "#f2f0ea",
    "--foreground": "#20242a"
  }
}
```

```jsonc
// build.config.acme.json
{ "app": { "name": "Acme", "shortName": "acme",
           "logo": "branding/acme/logo.png", "palette": "acme" } }
```

构建时 `vite.config.ts` 会生成 `:root[data-palette="acme"]{…}` 注入 `index.html`,
靠特异性压过 `.dark`(因此**仅亮色**,和内置 `teal` 一致)。

- **合法 token** = `packages/app/src/styles/globals.css` 顶层 `:root{}` 里声明的
  那些 `--xxx`;写了不存在的 token 名会**直接构建失败**(防打字静默失效)。
- 不填 `theme.json`(或 `palette` 为 `default`/`teal`)→ 不生成,产物零差异。
- token 值不得包含 `;`、`{`、`}`(防破坏 CSS),否则构建失败。
````

- [ ] **Step 2: Commit**

```bash
git add branding/README.md
git commit -m "docs(whitelabel): document per-brand theme.json convention"
```

---

## Task 4: 全量验证

- [ ] **Step 1: 脚本单测(含 CI 门控的 glob)**

Run: `pnpm test:scripts`
Expected: PASS — branding(6) + brand-theme(7) = 13 通过。

- [ ] **Step 2: 前端 typecheck + 单测**

Run: `pnpm typecheck && pnpm test:unit`
Expected: 无新增失败(已知预存 `App.tsx:91` 除外)。

- [ ] **Step 3: 默认零差异 + 占位符不残留**

```bash
pnpm --filter @teamclaw/app build >/dev/null 2>&1
echo "brand-theme count:"; grep -c 'id="brand-theme"' packages/app/dist/index.html
echo "placeholder leak:"; grep -c '__BRAND_THEME__' packages/app/dist/index.html
rm -rf packages/app/dist
git status --porcelain
```
Expected: brand-theme count `0`、placeholder leak `0`、`git status` 干净。

- [ ] **Step 4(手动): 品牌主题端到端**

```bash
mkdir -p branding/acme
printf '{"tokens":{"--primary":"#0f6e62","--background":"#f2f0ea"}}\n' > branding/acme/theme.json
printf '{"app":{"name":"Acme","shortName":"acme","palette":"acme"}}\n' > build.config.local.json
BUILD_ENV= pnpm --filter @teamclaw/app dev   # 浏览器看 acme 配色生效(主色/底色变化)
```
验证后 Ctrl-C 并清理:
```bash
rm -rf branding/acme build.config.local.json packages/app/dist
git status --porcelain   # 应为空
```
Expected: 页面用 acme 配色(primary #0f6e62、background #f2f0ea);清理后工作树干净。

- [ ] **Step 5(负向,手动): 未知 token 必须 fail build**

```bash
mkdir -p branding/bad
printf '{"tokens":{"--not-a-real-token":"#000"}}\n' > branding/bad/theme.json
printf '{"app":{"palette":"bad"}}\n' > build.config.local.json
pnpm --filter @teamclaw/app build; echo "exit=$?"
rm -rf branding/bad build.config.local.json packages/app/dist
```
Expected: 构建**失败**(非 0 退出),报错含 `unknown token name(s): --not-a-real-token`。

---

## Self-Review notes(规划者自检)

- **Spec coverage**:theme.json 结构(T1/T3)、纯生成器三函数(T1)、token 白名单取自 globals.css `:root`(T1 `extractRootTokenNames`)、未知 token fail build(T1 throw + T4 Step5 验证)、子集继承(只产出所给 token,T1 测试)、vite 注入 + `data-palette` 复用(T2)、不动 default/teal(T1 `resolveBrandTheme` 提前返回 null + T3 文档)、仅亮色(生成单条 `:root[data-palette]` 规则,无 dark)、默认零差异(T2 Step4 + T4 Step3)、文档/示例(T3)、测试(T1 单测 + T4)—— 全覆盖。
- **Placeholder scan**:每个 code step 给出完整代码与确切命令,无 TBD/占位。
- **Type/名称一致**:`extractRootTokenNames`/`generateBrandThemeCss`/`resolveBrandTheme` 三个名字在 T1 定义、T1 测试与 T2 import 处一致;`generateBrandThemeCss(palette, tokens, allowedTokens)` 形参顺序在定义与调用处一致;`__BRAND_THEME__` 占位符在 index.html(T2S1)与 vite replace(T2S3)一致;`<style id="brand-theme">` 在生成(T2S2)与冒烟断言(T2S5/T4S3)一致。

# 子工程 2：Chrome 扩展外壳 + 页面抓取 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把子工程 1 的浏览器版 `@teamclaw/app` 装进一个 MV3 Chrome 扩展的 side panel，并让用户能把当前网页内容（选中文本 / 全页 innerText）一键注入聊天输入框发给 agent。

**Architecture:** 用「app 静态 build + 手写 MV3 外壳」组合，绕开 crxjs/wxt 对 Vite 8 的兼容不确定性。新建 `apps/extension`：`build:web` 产出的 app dist 作为 side panel 页面；手写 `manifest.json` + `background`(service worker) + `content-script`，三者用 esbuild 编译。页面抓取经 `chrome.runtime` 消息：content script 抽取 → background 转发 → app 内 embed 监听器注入聊天 composer。app 侧改动（composer 插入总线 + chrome.runtime 监听 + 强制 embed + 相对 base）落在 `packages/app`，对无 chrome 环境(web/desktop)完全惰性。

**Tech Stack:** Manifest V3, TypeScript, esbuild（新增 devDep）, Vite 8（复用 app build:web）, Vitest(jsdom), `@types/chrome`（新增 devDep）。

## Global Constraints

- daemon 零改动；扩展不持有 daemon root token。
- app 侧新增的 chrome 相关代码必须对 `typeof chrome === 'undefined'`（web/desktop）完全惰性，不抛错、不改变现有行为。
- 平台判定沿用既有 `isTauri()`（`packages/app/src/lib/utils.ts`），不新造。
- 包命名 `@teamclaw/extension`；workspace 依赖用 `workspace:*`；pnpm@10.33.0，node>=20。
- 测试默认 locale `zh-CN`；mock `chrome` 全局，不依赖真实扩展运行时。
- MV3 background 用 ES module service worker（`"type":"module"`，对齐 `scripts/playwright-extension`）。
- 正文抽取只用 `innerText` 兜底，不引入 Readability。
- **已知基建依赖**：扩展页面是 secure context，浏览器禁止 `ws://`。**实际收发消息（MQTT）需 wss broker 端点**（见子工程设计 6.3）。本计划的扩展外壳 + 页面抓取→注入闭环不依赖 MQTT，可独立交付与测试；live 聊天收发是最后的手动 gate，标注为 blocked-on-wss。
- 提交粒度：每 Task 末尾一次 commit。

---

### Task 1: App — composer 插入总线 + ActorChatInput 接线

让外部（embed 监听器）能把文本追加进当前聊天输入框。`ActorChatInput` 现用本地 `useState` 存 `text`，引入一个轻量订阅总线打通。

**Files:**
- Create: `packages/app/src/lib/embed-composer-bus.ts`
- Test: `packages/app/src/lib/embed-composer-bus.test.ts`
- Modify: `packages/app/src/components/chat/ActorChatInput.tsx`

**Interfaces:**
- Produces:
  - `emitComposerInsert(text: string): void`
  - `subscribeComposerInsert(handler: (text: string) => void): () => void`

- [ ] **Step 1: 写失败测试**

```typescript
// packages/app/src/lib/embed-composer-bus.test.ts
import { describe, it, expect, vi } from 'vitest'
import { emitComposerInsert, subscribeComposerInsert } from './embed-composer-bus'

describe('embed-composer-bus', () => {
  it('delivers emitted text to subscribers', () => {
    const seen: string[] = []
    const off = subscribeComposerInsert((t) => seen.push(t))
    emitComposerInsert('hello')
    emitComposerInsert('world')
    expect(seen).toEqual(['hello', 'world'])
    off()
  })
  it('stops delivery after unsubscribe', () => {
    const fn = vi.fn()
    const off = subscribeComposerInsert(fn)
    off()
    emitComposerInsert('x')
    expect(fn).not.toHaveBeenCalled()
  })
})
```

- [ ] **Step 2: 运行确认失败**

Run: `cd packages/app && pnpm vitest run src/lib/embed-composer-bus.test.ts`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现总线**

```typescript
// packages/app/src/lib/embed-composer-bus.ts
type InsertHandler = (text: string) => void

const handlers = new Set<InsertHandler>()

/** Append text into the currently mounted chat composer. No-op if none mounted. */
export function emitComposerInsert(text: string): void {
  for (const h of handlers) h(text)
}

export function subscribeComposerInsert(handler: InsertHandler): () => void {
  handlers.add(handler)
  return () => handlers.delete(handler)
}
```

- [ ] **Step 4: 运行确认通过**

Run: `cd packages/app && pnpm vitest run src/lib/embed-composer-bus.test.ts`
Expected: PASS

- [ ] **Step 5: ActorChatInput 订阅插入**

在 `packages/app/src/components/chat/ActorChatInput.tsx`：加入 import 与一个 effect，把收到的文本追加进 `text`。在 `const [text, setText] = useState("")` 之后插入：

```tsx
// 顶部 import 区
import { useEffect } from "react";
import { subscribeComposerInsert } from "@/lib/embed-composer-bus";

// 组件体内，紧接 useState 声明之后：
useEffect(() => {
  return subscribeComposerInsert((insert) => {
    setText((prev) => (prev ? `${prev}\n\n${insert}` : insert));
  });
}, []);
```

（若文件已 import `useEffect`，复用现有 import，勿重复。）

- [ ] **Step 6: typecheck**

Run: `cd packages/app && pnpm typecheck`
Expected: 无新增错误

- [ ] **Step 7: Commit**

```bash
git add packages/app/src/lib/embed-composer-bus.ts packages/app/src/lib/embed-composer-bus.test.ts packages/app/src/components/chat/ActorChatInput.tsx
git commit -m "feat(app): composer insert bus wired into ActorChatInput"
```

---

### Task 2: App — embed chrome.runtime page-context 监听器

embed 模式下监听扩展发来的 `page-context` 消息，格式化后注入 composer。对无 chrome 环境完全惰性。

**Files:**
- Create: `packages/app/src/lib/embed-page-context.ts`
- Test: `packages/app/src/lib/embed-page-context.test.ts`
- Modify: `packages/app/src/App.tsx`（embed 分支挂载监听器）

**Interfaces:**
- Consumes: Task 1 的 `emitComposerInsert`。
- Produces:
  - `type PageContext = { title: string; url: string; text: string; selection: string }`
  - `formatPageContext(ctx: PageContext): string`
  - `startEmbedPageContextListener(): () => void`（无 chrome 时返回 no-op 清理函数）

- [ ] **Step 1: 写失败测试**

```typescript
// packages/app/src/lib/embed-page-context.test.ts
import { describe, it, expect, vi, afterEach } from 'vitest'
import { formatPageContext, startEmbedPageContextListener } from './embed-page-context'
import * as bus from './embed-composer-bus'

afterEach(() => { vi.restoreAllMocks(); delete (globalThis as Record<string, unknown>).chrome })

describe('formatPageContext', () => {
  it('prefers selection over full text and includes title+url', () => {
    const out = formatPageContext({ title: 'T', url: 'https://x', text: 'BODY', selection: 'SEL' })
    expect(out).toContain('SEL')
    expect(out).toContain('https://x')
    expect(out).not.toContain('BODY')
  })
  it('falls back to full text when no selection', () => {
    const out = formatPageContext({ title: 'T', url: 'https://x', text: 'BODY', selection: '' })
    expect(out).toContain('BODY')
  })
})

describe('startEmbedPageContextListener', () => {
  it('is a no-op (returns cleanup) when chrome is absent', () => {
    const off = startEmbedPageContextListener()
    expect(typeof off).toBe('function')
    off()
  })
  it('emits composer insert when a page-context message arrives', () => {
    let handler: ((m: unknown) => void) | null = null
    ;(globalThis as Record<string, unknown>).chrome = {
      runtime: {
        onMessage: {
          addListener: (h: (m: unknown) => void) => { handler = h },
          removeListener: () => {},
        },
      },
    }
    const spy = vi.spyOn(bus, 'emitComposerInsert')
    const off = startEmbedPageContextListener()
    handler!({ type: 'page-context', payload: { title: 'T', url: 'u', text: 'B', selection: 'S' } })
    expect(spy).toHaveBeenCalledOnce()
    expect(spy.mock.calls[0][0]).toContain('S')
    off()
  })
})
```

- [ ] **Step 2: 运行确认失败**

Run: `cd packages/app && pnpm vitest run src/lib/embed-page-context.test.ts`
Expected: FAIL

- [ ] **Step 3: 实现监听器**

```typescript
// packages/app/src/lib/embed-page-context.ts
import { emitComposerInsert } from './embed-composer-bus'

export type PageContext = { title: string; url: string; text: string; selection: string }

export function formatPageContext(ctx: PageContext): string {
  const body = ctx.selection.trim() || ctx.text.trim()
  const header = ctx.title ? `【${ctx.title}】` : ''
  return `${header}\n${ctx.url}\n\n${body}`.trim()
}

type ChromeLike = {
  runtime?: {
    onMessage?: {
      addListener: (h: (m: unknown) => void) => void
      removeListener: (h: (m: unknown) => void) => void
    }
  }
}

function isPageContextMessage(m: unknown): m is { type: 'page-context'; payload: PageContext } {
  return (
    typeof m === 'object' && m !== null &&
    (m as { type?: unknown }).type === 'page-context' &&
    typeof (m as { payload?: unknown }).payload === 'object'
  )
}

/** Listen for page-context messages from the extension and inject into the composer.
 *  No-op (returns a cleanup fn) when not running inside an extension (no chrome.runtime). */
export function startEmbedPageContextListener(): () => void {
  const c = (globalThis as unknown as { chrome?: ChromeLike }).chrome
  const onMessage = c?.runtime?.onMessage
  if (!onMessage) return () => {}
  const handler = (m: unknown) => {
    if (isPageContextMessage(m)) emitComposerInsert(formatPageContext(m.payload))
  }
  onMessage.addListener(handler)
  return () => onMessage.removeListener(handler)
}
```

- [ ] **Step 4: 运行确认通过**

Run: `cd packages/app && pnpm vitest run src/lib/embed-page-context.test.ts`
Expected: PASS（4 用例）

- [ ] **Step 5: App.tsx embed 分支挂载**

在 `packages/app/src/App.tsx` 的 embed 早返回分支（子工程 1 Task 5 加的 `if (embedMode) { ... }`）所在组件内，加一个 effect 挂载监听器。在 `AppContent` 顶部（其它 hooks 旁）加入：

```tsx
import { startEmbedPageContextListener } from "@/lib/embed-page-context";
// ...在 AppContent 组件体内：
useEffect(() => startEmbedPageContextListener(), []);
```

（该 effect 在非扩展环境是 no-op，故无需 embedMode 门控；若担心冗余可包 `if (embedMode)`，但 no-op 已足够惰性。）

- [ ] **Step 6: typecheck + commit**

Run: `cd packages/app && pnpm typecheck`（无新增错误）

```bash
git add packages/app/src/lib/embed-page-context.ts packages/app/src/lib/embed-page-context.test.ts packages/app/src/App.tsx
git commit -m "feat(app): embed page-context listener injects into composer"
```

---

### Task 3: App — 强制 embed（VITE_FORCE_EMBED）+ web 相对 base

扩展 side panel 加载 `index.html` 不可靠地携带 query，故让 embed 也能由 build env 强制；同时 web build 设相对 `base` 使资源在 `chrome-extension://` 下可加载。

**Files:**
- Modify: `packages/app/src/lib/embed-mode.ts`（env 强制）
- Test: `packages/app/src/lib/embed-mode.test.ts`（补 env 用例）
- Modify: `packages/app/src/stores/ui.ts`（embedMode 初始化兼顾 env）
- Modify: `packages/app/vite.config.ts`（web 模式 `base: './'`）

**Interfaces:**
- Produces: `resolveEmbedMode(search: string, forceEnv: string | undefined): 'chat' | null`（query 或 `forceEnv==='chat'` 任一命中即 chat）。

- [ ] **Step 1: 写失败测试**

```typescript
// 追加到 packages/app/src/lib/embed-mode.test.ts
import { resolveEmbedMode } from './embed-mode'

describe('resolveEmbedMode', () => {
  it('returns chat when env forces it even without query', () => {
    expect(resolveEmbedMode('', 'chat')).toBe('chat')
  })
  it('returns chat from query when env unset', () => {
    expect(resolveEmbedMode('?embed=chat', undefined)).toBe('chat')
  })
  it('returns null when neither', () => {
    expect(resolveEmbedMode('?x=1', undefined)).toBeNull()
    expect(resolveEmbedMode('', 'nope')).toBeNull()
  })
})
```

- [ ] **Step 2: 运行确认失败**

Run: `cd packages/app && pnpm vitest run src/lib/embed-mode.test.ts`
Expected: FAIL（`resolveEmbedMode` 未定义）

- [ ] **Step 3: 实现 resolveEmbedMode**

在 `packages/app/src/lib/embed-mode.ts` 追加（保留既有 `parseEmbedMode`）：

```typescript
export function resolveEmbedMode(
  search: string,
  forceEnv: string | undefined,
): 'chat' | null {
  if (forceEnv === 'chat') return 'chat'
  return parseEmbedMode(search)
}
```

- [ ] **Step 4: 运行确认通过**

Run: `cd packages/app && pnpm vitest run src/lib/embed-mode.test.ts`
Expected: PASS

- [ ] **Step 5: ui.ts 用 resolveEmbedMode**

把 `packages/app/src/stores/ui.ts` 里 `embedMode` 的初始化改为：

```typescript
import { resolveEmbedMode } from '@/lib/embed-mode'
// ...
embedMode:
  typeof window !== 'undefined'
    ? resolveEmbedMode(window.location.search, import.meta.env.VITE_FORCE_EMBED) === 'chat'
    : import.meta.env.VITE_FORCE_EMBED === 'chat',
```

- [ ] **Step 6: vite.config web 相对 base**

在 `packages/app/vite.config.ts` 的 config 返回对象中，按 web 模式设相对 base（桌面/默认路径不变）：

```typescript
base: process.env.VITE_APP_PLATFORM === 'web' ? './' : '/',
```

- [ ] **Step 7: 构建验证（相对路径生效）**

Run: `cd packages/app && VITE_FORCE_EMBED=chat pnpm build:web`
然后 Run: `cd packages/app && grep -c 'src="\./\|href="\./' dist/index.html`
Expected: 构建成功；`dist/index.html` 的资源引用为相对路径（`./assets/...`），grep 计数 ≥ 1。

- [ ] **Step 8: typecheck + commit**

Run: `cd packages/app && pnpm typecheck`（无新增错误）

```bash
git add packages/app/src/lib/embed-mode.ts packages/app/src/lib/embed-mode.test.ts packages/app/src/stores/ui.ts packages/app/vite.config.ts
git commit -m "feat(app): VITE_FORCE_EMBED + relative base for extension web build"
```

---

### Task 4: 扩展脚手架 — workspace + package + manifest + types

新建 `apps/extension` 包并纳入 workspace，准备 MV3 manifest 与 TS 配置。

**Files:**
- Modify: `pnpm-workspace.yaml`（纳入 `apps/*`）
- Create: `apps/extension/package.json`
- Create: `apps/extension/tsconfig.json`
- Create: `apps/extension/manifest.json`
- Create: `apps/extension/src/icons/.gitkeep`（占位，图标 Task 9 复制）

**Interfaces:**
- Produces: `@teamclaw/extension` 包，scripts `build`/`typecheck`/`test`。

- [ ] **Step 1: 纳入 workspace**

把 `pnpm-workspace.yaml` 的 `packages:` 列表加入 `apps/*`（保留现有项）：

```yaml
packages:
  - 'apps/*'
  - 'packages/*'
```

注：现有 `apps/desktop`、`apps/daemon` 等是 Rust/原生，无 `package.json` 或不应被 pnpm 当 JS 包管理。确认加 `apps/*` 后 `pnpm install` 不报错（pnpm 跳过无 package.json 的目录）；若某 apps 子目录含不该被纳入的 package.json 导致冲突，改为精确 `- 'apps/extension'` 与 `- 'apps/expo'`。

- [ ] **Step 2: package.json**

```json
// apps/extension/package.json
{
  "name": "@teamclaw/extension",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "scripts": {
    "build": "node build.mjs",
    "typecheck": "tsc --noEmit",
    "test": "vitest run"
  },
  "dependencies": {
    "@teamclaw/app": "workspace:*"
  },
  "devDependencies": {
    "@types/chrome": "^0.0.270",
    "esbuild": "^0.24.0",
    "typescript": "^5.6.0",
    "vitest": "^2.1.0"
  }
}
```

注：esbuild/vitest/typescript 版本以 `pnpm install` 后能解析为准；若与 root 锁定版本冲突，对齐 `packages/app` 既有版本（typescript、vitest 取 packages/app/package.json 同值）。

- [ ] **Step 3: tsconfig.json**

```json
// apps/extension/tsconfig.json
{
  "compilerOptions": {
    "target": "ES2020",
    "lib": ["ES2020", "DOM", "DOM.Iterable"],
    "module": "ESNext",
    "moduleResolution": "bundler",
    "strict": true,
    "noEmit": true,
    "types": ["chrome", "vitest/globals"],
    "skipLibCheck": true
  },
  "include": ["src", "build.mjs"]
}
```

- [ ] **Step 4: manifest.json**

```json
// apps/extension/manifest.json
{
  "manifest_version": 3,
  "name": "TeamClaw",
  "version": "0.1.0",
  "description": "TeamClaw 多人聊天侧边栏 + 当前页内容发给 agent",
  "permissions": ["sidePanel", "scripting", "activeTab"],
  "background": { "service_worker": "background.js", "type": "module" },
  "action": { "default_title": "TeamClaw" },
  "side_panel": { "default_path": "sidepanel/index.html" },
  "icons": {
    "16": "icons/icon-16.png",
    "48": "icons/icon-48.png",
    "128": "icons/icon-128.png"
  }
}
```

- [ ] **Step 5: 安装 + typecheck 空跑**

Run: `pnpm install`
Run: `cd apps/extension && pnpm typecheck`
Expected: install 成功；typecheck 通过（暂无 src ts 文件，空 include 也应 0 错；若报 "no inputs"，先建 Task 5 的文件再回跑——此处至少确认 install + 解析 @types/chrome 成功）。

- [ ] **Step 6: Commit**

```bash
git add pnpm-workspace.yaml apps/extension/package.json apps/extension/tsconfig.json apps/extension/manifest.json apps/extension/src/icons/.gitkeep pnpm-lock.yaml
git commit -m "chore(extension): scaffold @teamclaw/extension MV3 package"
```

---

### Task 5: 扩展 — 页面抽取纯函数

**Files:**
- Create: `apps/extension/src/lib/page-extract.ts`
- Test: `apps/extension/src/lib/page-extract.test.ts`

**Interfaces:**
- Produces:
  - `type ExtractedPage = { title: string; url: string; text: string; selection: string }`
  - `extractPage(doc: Document, win: { getSelection(): { toString(): string } | null }): ExtractedPage`

- [ ] **Step 1: 写失败测试**

```typescript
// apps/extension/src/lib/page-extract.test.ts
import { describe, it, expect } from 'vitest'
import { extractPage } from './page-extract'

function fakeDoc(title: string, url: string, bodyText: string): Document {
  return {
    title,
    location: { href: url },
    body: { innerText: bodyText },
  } as unknown as Document
}

describe('extractPage', () => {
  it('captures title, url, body innerText and empty selection', () => {
    const out = extractPage(fakeDoc('Hello', 'https://a/b', 'BODY TEXT'), { getSelection: () => null })
    expect(out).toEqual({ title: 'Hello', url: 'https://a/b', text: 'BODY TEXT', selection: '' })
  })
  it('captures selection when present', () => {
    const out = extractPage(fakeDoc('T', 'u', 'BODY'), { getSelection: () => ({ toString: () => 'SEL' }) })
    expect(out.selection).toBe('SEL')
  })
})
```

- [ ] **Step 2: 运行确认失败**

Run: `cd apps/extension && pnpm vitest run src/lib/page-extract.test.ts`
Expected: FAIL

- [ ] **Step 3: 实现**

```typescript
// apps/extension/src/lib/page-extract.ts
export type ExtractedPage = { title: string; url: string; text: string; selection: string }

export function extractPage(
  doc: Document,
  win: { getSelection(): { toString(): string } | null },
): ExtractedPage {
  const selection = win.getSelection()?.toString() ?? ''
  return {
    title: doc.title ?? '',
    url: doc.location?.href ?? '',
    text: doc.body?.innerText ?? '',
    selection,
  }
}
```

- [ ] **Step 4: 运行确认通过**

Run: `cd apps/extension && pnpm vitest run src/lib/page-extract.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/extension/src/lib/page-extract.ts apps/extension/src/lib/page-extract.test.ts
git commit -m "feat(extension): page extraction pure function"
```

---

### Task 6: 扩展 — 消息协议类型 + 守卫

**Files:**
- Create: `apps/extension/src/lib/messages.ts`
- Test: `apps/extension/src/lib/messages.test.ts`

**Interfaces:**
- Consumes: Task 5 的 `ExtractedPage`。
- Produces:
  - `type RequestPageMsg = { type: 'request-page' }`
  - `type PageContextMsg = { type: 'page-context'; payload: ExtractedPage }`
  - `isRequestPage(m: unknown): m is RequestPageMsg`
  - `isPageContext(m: unknown): m is PageContextMsg`
  - `pageContextMsg(payload: ExtractedPage): PageContextMsg`

- [ ] **Step 1: 写失败测试**

```typescript
// apps/extension/src/lib/messages.test.ts
import { describe, it, expect } from 'vitest'
import { isRequestPage, isPageContext, pageContextMsg } from './messages'

describe('messages', () => {
  it('recognizes request-page', () => {
    expect(isRequestPage({ type: 'request-page' })).toBe(true)
    expect(isRequestPage({ type: 'other' })).toBe(false)
    expect(isRequestPage(null)).toBe(false)
  })
  it('builds and recognizes page-context', () => {
    const m = pageContextMsg({ title: 'T', url: 'u', text: 'b', selection: '' })
    expect(m.type).toBe('page-context')
    expect(isPageContext(m)).toBe(true)
    expect(isPageContext({ type: 'page-context' })).toBe(false)
  })
})
```

- [ ] **Step 2: 运行确认失败**

Run: `cd apps/extension && pnpm vitest run src/lib/messages.test.ts`
Expected: FAIL

- [ ] **Step 3: 实现**

```typescript
// apps/extension/src/lib/messages.ts
import type { ExtractedPage } from './page-extract'

export type RequestPageMsg = { type: 'request-page' }
export type PageContextMsg = { type: 'page-context'; payload: ExtractedPage }

export function isRequestPage(m: unknown): m is RequestPageMsg {
  return typeof m === 'object' && m !== null && (m as { type?: unknown }).type === 'request-page'
}

export function isPageContext(m: unknown): m is PageContextMsg {
  return (
    typeof m === 'object' && m !== null &&
    (m as { type?: unknown }).type === 'page-context' &&
    typeof (m as { payload?: unknown }).payload === 'object' &&
    (m as { payload?: unknown }).payload !== null
  )
}

export function pageContextMsg(payload: ExtractedPage): PageContextMsg {
  return { type: 'page-context', payload }
}
```

- [ ] **Step 4: 运行确认通过**

Run: `cd apps/extension && pnpm vitest run src/lib/messages.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/extension/src/lib/messages.ts apps/extension/src/lib/messages.test.ts
git commit -m "feat(extension): runtime message types and guards"
```

---

### Task 7: 扩展 — content script

注入到 active tab，收到 `request-page` 时抽取页面并回传。逻辑抽成可测纯函数 + 薄 chrome 绑定。

**Files:**
- Create: `apps/extension/src/content-script.ts`
- Create: `apps/extension/src/lib/content-handler.ts`
- Test: `apps/extension/src/lib/content-handler.test.ts`

**Interfaces:**
- Consumes: Task 5 `extractPage`、Task 6 `isRequestPage`/`pageContextMsg`。
- Produces: `handleContentMessage(msg: unknown, deps: { doc: Document; win: {getSelection():{toString():string}|null} }): PageContextMsg | null`

- [ ] **Step 1: 写失败测试**

```typescript
// apps/extension/src/lib/content-handler.test.ts
import { describe, it, expect } from 'vitest'
import { handleContentMessage } from './content-handler'

const doc = { title: 'T', location: { href: 'u' }, body: { innerText: 'B' } } as unknown as Document
const win = { getSelection: () => null }

describe('handleContentMessage', () => {
  it('returns a page-context for request-page', () => {
    const out = handleContentMessage({ type: 'request-page' }, { doc, win })
    expect(out?.type).toBe('page-context')
    expect(out?.payload.text).toBe('B')
  })
  it('returns null for unrelated messages', () => {
    expect(handleContentMessage({ type: 'noop' }, { doc, win })).toBeNull()
  })
})
```

- [ ] **Step 2: 运行确认失败**

Run: `cd apps/extension && pnpm vitest run src/lib/content-handler.test.ts`
Expected: FAIL

- [ ] **Step 3: 实现 handler + content-script 绑定**

```typescript
// apps/extension/src/lib/content-handler.ts
import { extractPage } from './page-extract'
import { isRequestPage, pageContextMsg, type PageContextMsg } from './messages'

export function handleContentMessage(
  msg: unknown,
  deps: { doc: Document; win: { getSelection(): { toString(): string } | null } },
): PageContextMsg | null {
  if (!isRequestPage(msg)) return null
  return pageContextMsg(extractPage(deps.doc, deps.win))
}
```

```typescript
// apps/extension/src/content-script.ts
import { handleContentMessage } from './lib/content-handler'

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  const out = handleContentMessage(msg, { doc: document, win: window })
  if (out) {
    sendResponse(out)
    return true // keep the message channel open for the async response
  }
  return undefined
})
```

- [ ] **Step 4: 运行确认通过**

Run: `cd apps/extension && pnpm vitest run src/lib/content-handler.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/extension/src/content-script.ts apps/extension/src/lib/content-handler.ts apps/extension/src/lib/content-handler.test.ts
git commit -m "feat(extension): content script extracts page on request"
```

---

### Task 8: 扩展 — background service worker

点扩展图标打开 side panel；side panel 发 `request-page` 时，向 active tab 注入/调用 content script 取页面，再把 `page-context` 转发回 side panel。路由逻辑抽成可测纯函数。

**Files:**
- Create: `apps/extension/src/background.ts`
- Create: `apps/extension/src/lib/page-fetch.ts`
- Test: `apps/extension/src/lib/page-fetch.test.ts`

**Interfaces:**
- Consumes: Task 6 `isRequestPage`/`isPageContext`、`PageContextMsg`。
- Produces: `fetchActivePageContext(deps): Promise<PageContextMsg | null>`，其中
  `deps = { queryActiveTabId(): Promise<number | null>; sendToTab(tabId: number, msg: unknown): Promise<unknown> }`。

- [ ] **Step 1: 写失败测试**

```typescript
// apps/extension/src/lib/page-fetch.test.ts
import { describe, it, expect, vi } from 'vitest'
import { fetchActivePageContext } from './page-fetch'

describe('fetchActivePageContext', () => {
  it('sends request-page to the active tab and returns its page-context', async () => {
    const pc = { type: 'page-context', payload: { title: 'T', url: 'u', text: 'B', selection: '' } }
    const sendToTab = vi.fn().mockResolvedValue(pc)
    const out = await fetchActivePageContext({
      queryActiveTabId: async () => 7,
      sendToTab,
    })
    expect(sendToTab).toHaveBeenCalledWith(7, { type: 'request-page' })
    expect(out).toEqual(pc)
  })
  it('returns null when there is no active tab', async () => {
    const out = await fetchActivePageContext({
      queryActiveTabId: async () => null,
      sendToTab: vi.fn(),
    })
    expect(out).toBeNull()
  })
  it('returns null when the tab response is not a page-context', async () => {
    const out = await fetchActivePageContext({
      queryActiveTabId: async () => 1,
      sendToTab: async () => ({ type: 'nope' }),
    })
    expect(out).toBeNull()
  })
})
```

- [ ] **Step 2: 运行确认失败**

Run: `cd apps/extension && pnpm vitest run src/lib/page-fetch.test.ts`
Expected: FAIL

- [ ] **Step 3: 实现 page-fetch + background 绑定**

```typescript
// apps/extension/src/lib/page-fetch.ts
import { isPageContext, type PageContextMsg } from './messages'

export type PageFetchDeps = {
  queryActiveTabId(): Promise<number | null>
  sendToTab(tabId: number, msg: unknown): Promise<unknown>
}

export async function fetchActivePageContext(deps: PageFetchDeps): Promise<PageContextMsg | null> {
  const tabId = await deps.queryActiveTabId()
  if (tabId == null) return null
  const resp = await deps.sendToTab(tabId, { type: 'request-page' })
  return isPageContext(resp) ? resp : null
}
```

```typescript
// apps/extension/src/background.ts
import { fetchActivePageContext } from './lib/page-fetch'
import { isRequestPage } from './lib/messages'

// Open the side panel when the toolbar icon is clicked.
chrome.sidePanel
  .setPanelBehavior({ openPanelOnActionClick: true })
  .catch((e) => console.warn('[bg] setPanelBehavior failed', e))

// Side panel asks for the current page → fetch from the active tab and reply.
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!isRequestPage(msg)) return undefined
  void (async () => {
    const ctx = await fetchActivePageContext({
      queryActiveTabId: async () => {
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true })
        return tab?.id ?? null
      },
      sendToTab: async (tabId, m) => {
        try {
          // Ensure the content script is present, then deliver the request.
          await chrome.scripting.executeScript({
            target: { tabId },
            files: ['content-script.js'],
          })
        } catch (e) {
          console.warn('[bg] inject content-script failed (restricted page?)', e)
        }
        return chrome.tabs.sendMessage(tabId, m)
      },
    })
    sendResponse(ctx ?? { type: 'page-context', error: 'unavailable' })
  })()
  return true // async sendResponse
})
```

- [ ] **Step 4: 运行确认通过**

Run: `cd apps/extension && pnpm vitest run src/lib/page-fetch.test.ts`
Expected: PASS（3 用例）

- [ ] **Step 5: Commit**

```bash
git add apps/extension/src/background.ts apps/extension/src/lib/page-fetch.ts apps/extension/src/lib/page-fetch.test.ts
git commit -m "feat(extension): background routes page requests via active tab"
```

---

### Task 9: 扩展 — 构建组装脚本

把 app web build、background/content esbuild 产物、manifest、图标组装到 `apps/extension/dist`。

**Files:**
- Create: `apps/extension/build.mjs`
- Create: `apps/extension/icons/`（生成 3 个占位 PNG，见 Step）

**Interfaces:**
- Produces: `apps/extension/dist/{manifest.json, background.js, content-script.js, sidepanel/index.html, sidepanel/assets/*, icons/*}`。

- [ ] **Step 1: 写组装脚本**

```javascript
// apps/extension/build.mjs
import { build } from 'esbuild'
import { cpSync, mkdirSync, rmSync, existsSync } from 'node:fs'
import { execSync } from 'node:child_process'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const dist = resolve(here, 'dist')
const appDir = resolve(here, '../../packages/app')

rmSync(dist, { recursive: true, force: true })
mkdirSync(dist, { recursive: true })

// 1) Build the web app in forced-embed mode with relative base.
execSync('pnpm build:web', {
  cwd: appDir,
  stdio: 'inherit',
  env: { ...process.env, VITE_APP_PLATFORM: 'web', VITE_FORCE_EMBED: 'chat' },
})
cpSync(resolve(appDir, 'dist'), resolve(dist, 'sidepanel'), { recursive: true })

// 2) Bundle background (module worker) + content script (IIFE).
await build({
  entryPoints: { background: resolve(here, 'src/background.ts') },
  outdir: dist, bundle: true, format: 'esm', target: 'chrome110', platform: 'browser',
})
await build({
  entryPoints: { 'content-script': resolve(here, 'src/content-script.ts') },
  outdir: dist, bundle: true, format: 'iife', target: 'chrome110', platform: 'browser',
})

// 3) Copy manifest + icons.
cpSync(resolve(here, 'manifest.json'), resolve(dist, 'manifest.json'))
if (existsSync(resolve(here, 'icons'))) {
  cpSync(resolve(here, 'icons'), resolve(dist, 'icons'), { recursive: true })
}
console.log('[extension] built ->', dist)
```

- [ ] **Step 2: 生成占位图标**

Run（生成 3 个最小 PNG 占位）:
```bash
cd apps/extension && mkdir -p icons && for s in 16 48 128; do printf '\x89PNG\r\n\x1a\n' > "icons/icon-$s.png"; done
```
注：占位仅供加载不报错；正式图标后续替换。若 Chrome 拒绝非法 PNG，改用任意有效 1x1 PNG（可从 `scripts/playwright-extension/icons/` 复制并重命名为 icon-16/48/128.png）。

- [ ] **Step 3: 运行构建**

Run: `cd apps/extension && pnpm build`
Expected: 成功；`dist/` 下存在 `manifest.json`、`background.js`、`content-script.js`、`sidepanel/index.html`、`icons/icon-16.png`。

- [ ] **Step 4: 校验 dist 结构**

Run:
```bash
cd apps/extension && for f in manifest.json background.js content-script.js sidepanel/index.html icons/icon-16.png; do test -f "dist/$f" && echo "OK $f" || echo "MISSING $f"; done
```
Expected: 全部 `OK`。

- [ ] **Step 5: gitignore dist + commit**

Run: `cd apps/extension && printf 'dist/\nnode_modules/\n' > .gitignore`

```bash
git add apps/extension/build.mjs apps/extension/.gitignore apps/extension/icons/
git commit -m "build(extension): assemble app + worker + manifest into dist"
```

---

### Task 10: 手动 e2e gate — 装载扩展验证抓取→注入（+ live 聊天 blocked-on-wss）

无独立自动化；扩展运行时 + 真实页面。结果写入 PR 描述。

**Files:** 无代码改动（发现 bug 回到对应 Task 修复并补测试）。

- [ ] **Step 1: 构建并装载**

Run: `cd apps/extension && pnpm build`
Chrome → `chrome://extensions` → 开发者模式 → 「加载已解压的扩展程序」→ 选 `apps/extension/dist`。

- [ ] **Step 2: 打开 side panel**

点工具栏 TeamClaw 图标 → side panel 打开 → 显示登录界面（embed 精简布局）。
Expected: app 在 `chrome-extension://` 下正常渲染（资源相对 base 生效，无 404 白屏）。

- [ ] **Step 3: 页面抓取 → 注入**

在任意普通网页（如自家 admin portal）选中一段文字 → 在 side panel 点「抓取当前页」（或触发 `request-page`）。
Expected: 聊天输入框被注入 `【标题】\nURL\n\n选中文本`；无选中时注入全页 innerText。
（受限页如 `chrome://` 应提示不可抓取，不崩溃。）

- [ ] **Step 4: live 聊天（blocked-on-wss）**

⚠️ 扩展页面是 secure context，`ws://` 被禁。除非已完成 wss broker 基建（子工程设计 6.3）+ bootstrap 下发 wss URL，否则 MQTT 连不上、收发不可用。
- 若 wss 已就绪：登录 → 选会话 → 发消息 → 验证双向 + 流式回复。
- 若 wss 未就绪：记录「页面抓取→注入闭环通过；live 聊天待 wss 基建」即可。

- [ ] **Step 5: 记录验收**

把 Step 2-4 结果（截图/要点）写入子工程 2 PR 描述，明确标注 live 聊天是否被 wss 基建阻塞。

---

## Self-Review

- **Spec 覆盖**（对照设计 6 节）：side panel 宿主+图标开（Task 4 manifest + Task 8 setPanelBehavior）、background 转发（Task 8）、content script 抽取（Task 5/7）、chrome.runtime 协议（Task 6）、app 接收注入 composer（Task 1/2）、强制 embed + 相对 base（Task 3）、构建组装（Task 9）、错误处理（受限页 Task 8 catch + Task 10 验证）、wss 缺口显式标注（Global Constraints + Task 10 Step 4）。全部覆盖。
- **占位扫描**：无 TBD/TODO；每个 code step 含完整代码与可运行命令。图标用占位但给了有效 PNG 回退路径，非功能占位。
- **类型一致**：`ExtractedPage`（Task 5）被 Task 6/7 消费；`PageContextMsg`/`isRequestPage`/`isPageContext`（Task 6）被 Task 7/8 消费；`page-context` 消息形状在 Task 2（app 侧 `PageContext`）与 Task 5/6（扩展侧 `ExtractedPage`）字段一致（title/url/text/selection），经 chrome.runtime 跨边界传 JSON，结构匹配。`emitComposerInsert`（Task 1）被 Task 2 消费。
- **已知依赖/风险**：①live 聊天依赖 wss 基建（非本计划范畴，Task 10 标注）；②`pnpm-workspace.yaml` 加 `apps/*` 若与现有非 JS apps 冲突，Task 4 Step 1 给了精确列表回退；③esbuild/vitest/typescript 版本以 install 解析为准，给了对齐 packages/app 的回退；④图标占位需正式资源替换。

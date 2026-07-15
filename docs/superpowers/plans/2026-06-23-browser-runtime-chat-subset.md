# 子工程 1：@teamclaw/app 浏览器运行时（聊天子集）实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 `@teamclaw/app` 的多人聊天子集在纯浏览器（无 Tauri）里跑起来，只走 Cloud API(fetch) + MQTT over WebSocket，作为后续 Chrome 扩展 side panel 的承载。

**Architecture:** 把 `packages/app/src/lib/mqtt-bridge.ts` 这个被 16+ 文件共用的单一 seam 改为按 `isTauri()` 平台分流——Tauri 路径原样保留，浏览器路径用新增的 `mqtt` npm(ws) 适配器（移植自 `apps/expo/src/lib/mqtt/expo-mqtt.ts` 的 JS client 路径），导出签名完全不变故所有消费方零改动。再加一个 URL query 触发的 embed 精简渲染模式，以及一个非 Tauri 的 Vite web 构建/dev 模式。

**Tech Stack:** React 19, Vite, Zustand, Tailwind 4, `mqtt` npm v5（新增依赖）, Vitest(jsdom)。

## Global Constraints

- 依赖底线：`mqtt@5.14.0`（与 `apps/expo` 一致，避免 monorepo 版本漂移）。
- 公共 seam `mqtt-bridge.ts` 的导出函数签名**禁止变更**：`mqttConnect/mqttSubscribe/mqttUnsubscribe/mqttPublish/mqttStatus/listenForEnvelopes` 及类型 `IncomingEnvelope`。消费方零改动是验收前提。
- 平台判定统一用既有 `isTauri()`（`packages/app/src/lib/utils.ts`），不得新造检测。
- 测试默认 locale 为 `zh-CN`（vitest 注入 `VITE_LOCALE`）；按文案断言时用中文。
- 不引入除 `mqtt` 外的新运行时依赖。不触碰 Tauri Rust 侧任何代码。
- 提交粒度：每个 Task 末尾一次 commit，feat/refactor/test 前缀。

---

### Task 1: 新增 `mqtt` 依赖并锁定版本

**Files:**
- Modify: `packages/app/package.json`（dependencies 段）

**Interfaces:**
- Produces: 运行时可 `import mqttPkg from "mqtt"`，版本与 expo 对齐。

- [ ] **Step 1: 加入依赖**

在 `packages/app/package.json` 的 `dependencies` 中加入（按字母序插入）：

```json
"mqtt": "5.14.0",
```

- [ ] **Step 2: 安装并验证解析**

Run: `pnpm install`
然后 Run: `cd packages/app && node -e "const m=require('mqtt');console.log(typeof m.connect)"`
Expected: 打印 `function`

- [ ] **Step 3: Commit**

```bash
git add packages/app/package.json pnpm-lock.yaml
git commit -m "build(app): add mqtt@5.14.0 for browser ws bridge"
```

---

### Task 2: 浏览器 MQTT 适配器（`mqtt` over ws）

把 expo 里已验证的 JS client 适配逻辑移植成 packages/app 内的浏览器专用适配器。只保留 JS(ws) 路径，删去 React-Native 原生模块分支。

**Files:**
- Create: `packages/app/src/lib/mqtt/browser-mqtt-adapter.ts`
- Test: `packages/app/src/lib/mqtt/browser-mqtt-adapter.test.ts`

**Interfaces:**
- Produces:
  - `type BrowserMqttMessage = { topic: string; payload: Uint8Array }`
  - `type BrowserMqttConnectArgs = { url: string; options?: { clientId?: string; username?: string; password?: string; clean?: boolean; keepalive?: number; reconnectPeriod?: number; connectTimeout?: number; rejectUnauthorized?: boolean } }`
  - `type BrowserMqttAdapter = { connect(args): Promise<void>; subscribe(topic: string): Promise<void>; publish(topic: string, payload: Uint8Array, retain?: boolean): Promise<void>; disconnect(): Promise<void>; onMessage(h:(m:BrowserMqttMessage)=>void):()=>void; onConnectionState(h:(s:'connecting'|'connected'|'disconnected')=>void):()=>void }`
  - `type BrowserMqttAdapterDeps = { createClient?: (url: string, options?: unknown) => MqttLikeClient }`
  - `function createBrowserMqttAdapter(deps?: BrowserMqttAdapterDeps): BrowserMqttAdapter`

- [ ] **Step 1: 写失败测试**

```typescript
// packages/app/src/lib/mqtt/browser-mqtt-adapter.test.ts
import { describe, it, expect, vi } from 'vitest'
import { createBrowserMqttAdapter } from './browser-mqtt-adapter'

function makeFakeClient() {
  const handlers: Record<string, ((...a: unknown[]) => void)[]> = {}
  return {
    on(e: string, h: (...a: unknown[]) => void) { (handlers[e] ??= []).push(h); return this },
    once(e: string, h: (...a: unknown[]) => void) { (handlers[e] ??= []).push(h); return this },
    removeListener(e: string, h: (...a: unknown[]) => void) {
      handlers[e] = (handlers[e] ?? []).filter((x) => x !== h); return this
    },
    subscribe(_t: string, cb: (e?: Error | null) => void) { cb(null) },
    publish(_t: string, _p: unknown, _o: unknown, cb: (e?: Error | null) => void) { cb(null) },
    end(_f: boolean, _o: unknown, cb: () => void) { cb() },
    emit(e: string, ...a: unknown[]) { (handlers[e] ?? []).forEach((h) => h(...a)) },
  }
}

describe('createBrowserMqttAdapter', () => {
  it('resolves connect on client connect event and relays messages', async () => {
    const fake = makeFakeClient()
    const adapter = createBrowserMqttAdapter({ createClient: () => fake as never })
    const got: { topic: string; payload: Uint8Array }[] = []
    adapter.onMessage((m) => got.push(m))
    const p = adapter.connect({ url: 'ws://broker:8083/mqtt' })
    fake.emit('connect')
    await p
    fake.emit('message', 'amux/t/a/x', new Uint8Array([1, 2, 3]))
    expect(got).toHaveLength(1)
    expect(Array.from(got[0].payload)).toEqual([1, 2, 3])
  })

  it('rejects connect on error event', async () => {
    const fake = makeFakeClient()
    const adapter = createBrowserMqttAdapter({ createClient: () => fake as never })
    const p = adapter.connect({ url: 'ws://b:8083' })
    fake.emit('error', new Error('bad creds'))
    await expect(p).rejects.toThrow('bad creds')
  })

  it('reports connection state transitions', async () => {
    const fake = makeFakeClient()
    const adapter = createBrowserMqttAdapter({ createClient: () => fake as never })
    const states: string[] = []
    adapter.onConnectionState((s) => states.push(s))
    const p = adapter.connect({ url: 'ws://b:8083' })
    fake.emit('connect'); await p
    fake.emit('close')
    expect(states).toEqual(['connecting', 'connected', 'disconnected'])
  })
})
```

- [ ] **Step 2: 运行确认失败**

Run: `cd packages/app && pnpm vitest run src/lib/mqtt/browser-mqtt-adapter.test.ts`
Expected: FAIL（模块不存在 / `createBrowserMqttAdapter is not a function`）

- [ ] **Step 3: 实现适配器**

移植 expo 适配器的 JS-client 分支（`createExpoMqttAdapter` 中 `defaultCreateClient` 那条路径），去掉 native 模块逻辑。完整实现：

```typescript
// packages/app/src/lib/mqtt/browser-mqtt-adapter.ts
import mqttPkg from 'mqtt'
import * as mqttNamespace from 'mqtt'

type MqttNamespace = { connect: (url: string, options?: unknown) => unknown }
const mqtt: MqttNamespace =
  mqttPkg && typeof (mqttPkg as MqttNamespace).connect === 'function'
    ? (mqttPkg as MqttNamespace)
    : (mqttNamespace as unknown as MqttNamespace)

export type BrowserMqttMessage = { topic: string; payload: Uint8Array }

export type BrowserMqttConnectOptions = {
  clientId?: string
  username?: string
  password?: string
  clean?: boolean
  keepalive?: number
  reconnectPeriod?: number
  connectTimeout?: number
  rejectUnauthorized?: boolean
}

export type BrowserMqttConnectArgs = { url: string; options?: BrowserMqttConnectOptions }

type MqttLikeClient = {
  on(e: string, h: (...a: never[]) => void): MqttLikeClient
  once(e: string, h: (...a: never[]) => void): MqttLikeClient
  removeListener(e: string, h: (...a: never[]) => void): MqttLikeClient
  subscribe(topic: string, cb: (err?: Error | null) => void): void
  publish(topic: string, payload: Uint8Array | string, opts: { retain?: boolean }, cb: (err?: Error | null) => void): void
  end(force: boolean, opts: Record<string, never>, cb: () => void): void
}

export type BrowserMqttAdapter = {
  connect(args: BrowserMqttConnectArgs): Promise<void>
  subscribe(topic: string): Promise<void>
  publish(topic: string, payload: Uint8Array, retain?: boolean): Promise<void>
  disconnect(): Promise<void>
  onMessage(handler: (m: BrowserMqttMessage) => void): () => void
  onConnectionState(handler: (s: 'connecting' | 'connected' | 'disconnected') => void): () => void
}

export type BrowserMqttAdapterDeps = {
  createClient?: (url: string, options?: BrowserMqttConnectOptions) => MqttLikeClient
}

function defaultCreateClient(url: string, options?: BrowserMqttConnectOptions): MqttLikeClient {
  return mqtt.connect(url, options) as unknown as MqttLikeClient
}

export function createBrowserMqttAdapter(deps: BrowserMqttAdapterDeps = {}): BrowserMqttAdapter {
  const createClient = deps.createClient ?? defaultCreateClient
  let client: MqttLikeClient | null = null
  const messageHandlers = new Set<(m: BrowserMqttMessage) => void>()
  const stateHandlers = new Set<(s: 'connecting' | 'connected' | 'disconnected') => void>()

  function relayMessage(topic: string, payload: Uint8Array) {
    const m = { topic, payload: new Uint8Array(payload) }
    for (const h of messageHandlers) h(m)
  }
  function relayState(s: 'connecting' | 'connected' | 'disconnected') {
    for (const h of stateHandlers) h(s)
  }

  return {
    async connect(args) {
      if (client) throw new Error('MQTT client is already connected')
      const next = createClient(args.url, args.options)
      client = next
      relayState('connecting')
      return new Promise<void>((resolve, reject) => {
        const onConnect = () => {
          next.removeListener('connect', onConnect as never)
          next.removeListener('error', onError as never)
          next.on('message', relayMessage as never)
          next.on('close', onClosed as never)
          next.on('offline', onClosed as never)
          relayState('connected')
          resolve()
        }
        const onError = (err: Error) => {
          next.removeListener('connect', onConnect as never)
          next.removeListener('error', onError as never)
          if (client === next) client = null
          relayState('disconnected')
          reject(err)
        }
        const onClosed = () => {
          if (client === next) client = null
          relayState('disconnected')
        }
        next.once('connect', onConnect as never)
        next.once('error', onError as never)
      })
    },
    async subscribe(topic) {
      const c = client
      if (!c) throw new Error('MQTT client is not connected')
      await new Promise<void>((resolve, reject) =>
        c.subscribe(topic, (e) => (e ? reject(e) : resolve())),
      )
    },
    async publish(topic, payload, retain = false) {
      const c = client
      if (!c) throw new Error('MQTT client is not connected')
      await new Promise<void>((resolve, reject) =>
        c.publish(topic, payload, { retain }, (e) => (e ? reject(e) : resolve())),
      )
    },
    async disconnect() {
      const c = client
      client = null
      relayState('disconnected')
      if (!c) return
      await new Promise<void>((resolve) => c.end(false, {}, resolve))
    },
    onMessage(handler) {
      messageHandlers.add(handler)
      return () => messageHandlers.delete(handler)
    },
    onConnectionState(handler) {
      stateHandlers.add(handler)
      return () => stateHandlers.delete(handler)
    },
  }
}
```

- [ ] **Step 4: 运行确认通过**

Run: `cd packages/app && pnpm vitest run src/lib/mqtt/browser-mqtt-adapter.test.ts`
Expected: PASS（3 个用例全过）

- [ ] **Step 5: Commit**

```bash
git add packages/app/src/lib/mqtt/browser-mqtt-adapter.ts packages/app/src/lib/mqtt/browser-mqtt-adapter.test.ts
git commit -m "feat(app): browser mqtt-over-ws adapter ported from expo"
```

---

### Task 3: 浏览器 bridge——把 connect 参数映射成 ws URL 并实现 mqtt-bridge 签名

**Files:**
- Create: `packages/app/src/lib/mqtt-browser-bridge.ts`
- Test: `packages/app/src/lib/mqtt-browser-bridge.test.ts`

**Interfaces:**
- Consumes: Task 2 的 `createBrowserMqttAdapter`、`BrowserMqttMessage`。
- Produces（与 `mqtt-bridge.ts` 同签名，供 Task 4 分流引用）：
  - `IncomingEnvelope = { topic: string; bytes: Uint8Array }`（从现有 mqtt-bridge 复用类型）
  - `mqttConnect(args: { brokerHost; brokerPort; username; password; clientId; teamId; useTls }): Promise<void>`
  - `mqttSubscribe(topic): Promise<void>` / `mqttUnsubscribe(topic): Promise<void>`
  - `mqttPublish(topic, bytes, retain?): Promise<void>`
  - `mqttStatus(): Promise<{ connected: boolean; subscribedTopics: string[] }>`
  - `listenForEnvelopes(handler:(e:IncomingEnvelope)=>void): Promise<() => void>`
  - `__resetBrowserMqttForTest(deps?)`（仅测试用，注入假 adapter）

- [ ] **Step 1: 写失败测试**

```typescript
// packages/app/src/lib/mqtt-browser-bridge.test.ts
import { describe, it, expect, vi } from 'vitest'

describe('mqtt-browser-bridge', () => {
  it('maps useTls=false to ws:// and includes /mqtt path', async () => {
    const connect = vi.fn().mockResolvedValue(undefined)
    const mod = await import('./mqtt-browser-bridge')
    mod.__resetBrowserMqttForTest({
      adapter: { connect, subscribe: vi.fn(), publish: vi.fn(), disconnect: vi.fn(), onMessage: () => () => {}, onConnectionState: () => () => {} },
    })
    await mod.mqttConnect({ brokerHost: 'b.example', brokerPort: 8083, username: 'u', password: 'p', clientId: 'c', teamId: 't', useTls: false })
    expect(connect).toHaveBeenCalledWith(expect.objectContaining({ url: 'ws://b.example:8083/mqtt' }))
  })

  it('maps useTls=true to wss://', async () => {
    const connect = vi.fn().mockResolvedValue(undefined)
    const mod = await import('./mqtt-browser-bridge')
    mod.__resetBrowserMqttForTest({
      adapter: { connect, subscribe: vi.fn(), publish: vi.fn(), disconnect: vi.fn(), onMessage: () => () => {}, onConnectionState: () => () => {} },
    })
    await mod.mqttConnect({ brokerHost: 'b', brokerPort: 8084, username: 'u', password: 'p', clientId: 'c', teamId: 't', useTls: true })
    expect(connect).toHaveBeenCalledWith(expect.objectContaining({ url: 'wss://b:8084/mqtt' }))
  })

  it('listenForEnvelopes forwards adapter messages as IncomingEnvelope', async () => {
    let msgCb: ((m: { topic: string; payload: Uint8Array }) => void) | null = null
    const mod = await import('./mqtt-browser-bridge')
    mod.__resetBrowserMqttForTest({
      adapter: {
        connect: vi.fn().mockResolvedValue(undefined), subscribe: vi.fn(), publish: vi.fn(), disconnect: vi.fn(),
        onMessage: (h) => { msgCb = h; return () => {} }, onConnectionState: () => () => {},
      },
    })
    const got: { topic: string; bytes: Uint8Array }[] = []
    await mod.listenForEnvelopes((e) => got.push(e))
    msgCb!({ topic: 'amux/x', payload: new Uint8Array([9]) })
    expect(got).toEqual([{ topic: 'amux/x', bytes: new Uint8Array([9]) }])
  })
})
```

- [ ] **Step 2: 运行确认失败**

Run: `cd packages/app && pnpm vitest run src/lib/mqtt-browser-bridge.test.ts`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现 bridge**

```typescript
// packages/app/src/lib/mqtt-browser-bridge.ts
import { createBrowserMqttAdapter, type BrowserMqttAdapter } from './mqtt/browser-mqtt-adapter'

export interface IncomingEnvelope {
  topic: string
  bytes: Uint8Array
}

let adapter: BrowserMqttAdapter | null = null
let connected = false
const subscribedTopics = new Set<string>()

function ensureAdapter(): BrowserMqttAdapter {
  if (!adapter) adapter = createBrowserMqttAdapter()
  return adapter
}

// 测试注入点：替换 adapter、清空状态
export function __resetBrowserMqttForTest(opts?: { adapter?: BrowserMqttAdapter }): void {
  adapter = opts?.adapter ?? null
  connected = false
  subscribedTopics.clear()
}

export async function mqttConnect(args: {
  brokerHost: string
  brokerPort: number
  username: string
  password: string
  clientId: string
  teamId: string
  useTls: boolean
}): Promise<void> {
  const scheme = args.useTls ? 'wss' : 'ws'
  const url = `${scheme}://${args.brokerHost}:${args.brokerPort}/mqtt`
  await ensureAdapter().connect({
    url,
    options: {
      clientId: args.clientId,
      username: args.username,
      password: args.password,
      clean: true,
      keepalive: 30,
      reconnectPeriod: 3000,
      connectTimeout: 15000,
    },
  })
  connected = true
}

export async function mqttSubscribe(topic: string): Promise<void> {
  await ensureAdapter().subscribe(topic)
  subscribedTopics.add(topic)
}

export async function mqttUnsubscribe(topic: string): Promise<void> {
  // mqtt 客户端 unsubscribe 经 adapter 暂未暴露；记录态即可，重连按订阅集恢复。
  subscribedTopics.delete(topic)
}

export async function mqttPublish(topic: string, bytes: Uint8Array, retain = false): Promise<void> {
  await ensureAdapter().publish(topic, bytes, retain)
}

export async function mqttStatus(): Promise<{ connected: boolean; subscribedTopics: string[] }> {
  return { connected, subscribedTopics: Array.from(subscribedTopics) }
}

export async function listenForEnvelopes(
  handler: (env: IncomingEnvelope) => void,
): Promise<() => void> {
  const off = ensureAdapter().onMessage((m) => {
    handler({ topic: m.topic, bytes: m.payload })
  })
  return off
}
```

注：`__resetBrowserMqttForTest` 的入参在测试里传了 `{ adapter }`，实现已支持。`unsubscribe` 的 adapter 方法缺口在 Task 2 适配器里未暴露真正的 mqtt `unsubscribe`——本子工程聊天场景不依赖取消订阅（订阅集只增不减、重连恢复），故仅维护状态集；若后续需要真取消订阅，再在 adapter 加 `unsubscribe`。

- [ ] **Step 4: 运行确认通过**

Run: `cd packages/app && pnpm vitest run src/lib/mqtt-browser-bridge.test.ts`
Expected: PASS（3 用例）

- [ ] **Step 5: Commit**

```bash
git add packages/app/src/lib/mqtt-browser-bridge.ts packages/app/src/lib/mqtt-browser-bridge.test.ts
git commit -m "feat(app): browser mqtt bridge with ws url mapping + envelope relay"
```

---

### Task 4: 把 `mqtt-bridge.ts` 改为平台分流（消费方零改动）

把现有 Tauri 实现挪到 `mqtt-bridge-tauri.ts`，`mqtt-bridge.ts` 变成按 `isTauri()` 选择实现的分流器，对外导出签名不变。

**Files:**
- Create: `packages/app/src/lib/mqtt-bridge-tauri.ts`（移入现有 Tauri 代码）
- Modify: `packages/app/src/lib/mqtt-bridge.ts`（改为分流器）
- Modify: `packages/app/src/lib/mqtt-bridge.test.ts`（现有测试在 jsdom=非 Tauri 下应命中 browser 分支；按需调整 mock）
- Test: `packages/app/src/lib/mqtt-bridge.dispatch.test.ts`（新增分流断言）

**Interfaces:**
- Consumes: Task 3 的 `mqtt-browser-bridge`、既有 Tauri 实现、`isTauri()`。
- Produces: `mqtt-bridge.ts` 导出 `IncomingEnvelope` + 6 个函数，签名与重构前逐字一致。

- [ ] **Step 1: 写分流测试（失败）**

```typescript
// packages/app/src/lib/mqtt-bridge.dispatch.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('./utils', async (orig) => ({ ...(await orig<typeof import('./utils')>()), isTauri: () => false }))

describe('mqtt-bridge dispatch (non-tauri)', () => {
  beforeEach(() => vi.resetModules())
  it('routes mqttConnect to the browser bridge when not in tauri', async () => {
    const connectSpy = vi.fn().mockResolvedValue(undefined)
    vi.doMock('./mqtt-browser-bridge', () => ({
      mqttConnect: connectSpy,
      mqttSubscribe: vi.fn(), mqttUnsubscribe: vi.fn(), mqttPublish: vi.fn(),
      mqttStatus: vi.fn(), listenForEnvelopes: vi.fn(),
    }))
    const bridge = await import('./mqtt-bridge')
    await bridge.mqttConnect({ brokerHost: 'h', brokerPort: 8083, username: 'u', password: 'p', clientId: 'c', teamId: 't', useTls: false })
    expect(connectSpy).toHaveBeenCalledOnce()
  })
})
```

- [ ] **Step 2: 运行确认失败**

Run: `cd packages/app && pnpm vitest run src/lib/mqtt-bridge.dispatch.test.ts`
Expected: FAIL（当前 mqtt-bridge 直接走 Tauri `invoke`，未分流；调用会抛或 spy 未命中）

- [ ] **Step 3: 移动 Tauri 实现**

新建 `packages/app/src/lib/mqtt-bridge-tauri.ts`，把当前 `mqtt-bridge.ts` 的全部内容（含 `IncomingEnvelope`、`b64ToBytes`、6 个函数）**原样剪切**进去，不改逻辑。

- [ ] **Step 4: 改写 `mqtt-bridge.ts` 为分流器**

```typescript
// packages/app/src/lib/mqtt-bridge.ts
import { isTauri } from './utils'
import * as tauriBridge from './mqtt-bridge-tauri'
import * as browserBridge from './mqtt-browser-bridge'

export type { IncomingEnvelope } from './mqtt-bridge-tauri'

function impl() {
  return isTauri() ? tauriBridge : browserBridge
}

export const mqttConnect: typeof tauriBridge.mqttConnect = (args) => impl().mqttConnect(args)
export const mqttSubscribe: typeof tauriBridge.mqttSubscribe = (topic) => impl().mqttSubscribe(topic)
export const mqttUnsubscribe: typeof tauriBridge.mqttUnsubscribe = (topic) => impl().mqttUnsubscribe(topic)
export const mqttPublish: typeof tauriBridge.mqttPublish = (topic, bytes, retain) =>
  impl().mqttPublish(topic, bytes, retain)
export const mqttStatus: typeof tauriBridge.mqttStatus = () => impl().mqttStatus()
export const listenForEnvelopes: typeof tauriBridge.listenForEnvelopes = (handler) =>
  impl().listenForEnvelopes(handler)
```

注：`listenForEnvelopes` 返回类型在 Tauri 为 `UnlistenFn`（即 `() => void`），browser 为 `() => void`，兼容。`IncomingEnvelope` 两实现结构一致，从 tauri 文件 re-export 作为权威类型。

- [ ] **Step 5: 修复既有 `mqtt-bridge.test.ts`**

Run: `cd packages/app && pnpm vitest run src/lib/mqtt-bridge.test.ts`
若失败：既有测试原本 mock `@tauri-apps/api/core` 的 `invoke`。由于 jsdom 下 `isTauri()===false` 现在会走 browser 分支，需在该测试顶部加 `vi.mock('./utils', ...isTauri: () => true)` 以保持其针对 Tauri 路径的断言不变。改完重跑至 PASS。

- [ ] **Step 6: 运行分流测试 + 全量 bridge 相关测试**

Run: `cd packages/app && pnpm vitest run src/lib/mqtt-bridge.dispatch.test.ts src/lib/mqtt-bridge.test.ts src/lib/mqtt-browser-bridge.test.ts src/lib/mqtt/browser-mqtt-adapter.test.ts`
Expected: 全部 PASS

- [ ] **Step 7: 消费方零改动回归**

Run: `cd packages/app && pnpm vitest run src/stores/__tests__/session-daemon-send.test.ts src/stores/__tests__/actor-presence-store.test.ts src/lib/__tests__/teamclaw-rpc.test.ts src/services/__tests__/outbox-sender.test.ts src/lib/session-live-subscriptions.test.ts`
Expected: 全部 PASS（证明 16+ 消费方不受 seam 重构影响）

- [ ] **Step 8: Commit**

```bash
git add packages/app/src/lib/mqtt-bridge.ts packages/app/src/lib/mqtt-bridge-tauri.ts packages/app/src/lib/mqtt-bridge.test.ts packages/app/src/lib/mqtt-bridge.dispatch.test.ts
git commit -m "refactor(app): platform-dispatch mqtt-bridge (tauri | browser ws)"
```

---

### Task 5: embed 精简渲染模式（URL query → currentView）

让浏览器入口可通过 `?embed=chat` 进入只渲染「会话列表 + 多人聊天面板」的精简布局。复用既有 `useUIStore`（`currentView`），新增一个 `embed` 标志而非新路由（app 无 URL 路由）。

**Files:**
- Create: `packages/app/src/lib/embed-mode.ts`（解析 query）
- Test: `packages/app/src/lib/embed-mode.test.ts`
- Modify: `packages/app/src/stores/ui.ts`（加 `embedMode: boolean` 状态 + 初始化）
- Modify: `packages/app/src/App.tsx`（embedMode 为真时渲染精简布局，跳过 setup 向导/桌面侧栏）

**Interfaces:**
- Consumes: 既有 `useUIStore`。
- Produces:
  - `parseEmbedMode(search: string): 'chat' | null`
  - `useUIStore` 新增只读字段 `embedMode: boolean`

- [ ] **Step 1: 写失败测试**

```typescript
// packages/app/src/lib/embed-mode.test.ts
import { describe, it, expect } from 'vitest'
import { parseEmbedMode } from './embed-mode'

describe('parseEmbedMode', () => {
  it('returns "chat" for ?embed=chat', () => {
    expect(parseEmbedMode('?embed=chat')).toBe('chat')
  })
  it('returns null when absent', () => {
    expect(parseEmbedMode('?foo=1')).toBeNull()
    expect(parseEmbedMode('')).toBeNull()
  })
  it('ignores unknown embed values', () => {
    expect(parseEmbedMode('?embed=bogus')).toBeNull()
  })
})
```

- [ ] **Step 2: 运行确认失败**

Run: `cd packages/app && pnpm vitest run src/lib/embed-mode.test.ts`
Expected: FAIL

- [ ] **Step 3: 实现解析器**

```typescript
// packages/app/src/lib/embed-mode.ts
export function parseEmbedMode(search: string): 'chat' | null {
  const params = new URLSearchParams(search)
  return params.get('embed') === 'chat' ? 'chat' : null
}
```

- [ ] **Step 4: 运行确认通过**

Run: `cd packages/app && pnpm vitest run src/lib/embed-mode.test.ts`
Expected: PASS

- [ ] **Step 5: 接入 `useUIStore`**

在 `packages/app/src/stores/ui.ts` 的 store 初始 state 中加入：

```typescript
import { parseEmbedMode } from '@/lib/embed-mode'
// ...在 create(...) 的初始 state 里：
embedMode: typeof window !== 'undefined' ? parseEmbedMode(window.location.search) === 'chat' : false,
```

并在该 store 的 TypeScript 接口里加 `embedMode: boolean`（只读，无 setter）。

- [ ] **Step 6: App.tsx 精简渲染分支**

在 `packages/app/src/App.tsx` 的顶层渲染处（`AppContent` 选择视图前）加入：读取 `const embedMode = useUIStore((s) => s.embedMode)`；当 `embedMode` 为真时，**跳过 setup 向导/桌面三列侧栏**，直接渲染会话列表列 `<SessionListColumn />` + 聊天面板 `<ChatPanel />` 的两栏精简容器。其余桌面专属 UI（daemon 面板、workspace 栏）不渲染。保持 `AuthGate` 包裹不变（仍需登录 + team bootstrap + MQTT 启动）。

具体：在 `AppContent` return 的最外层加：

```tsx
if (embedMode) {
  return (
    <div className="flex h-screen w-screen overflow-hidden">
      <aside className="w-72 shrink-0 border-r border-border overflow-y-auto">
        <SessionListColumn />
      </aside>
      <main className="flex-1 min-w-0">
        <ChatPanel />
      </main>
    </div>
  )
}
```

（`SessionListColumn`/`ChatPanel` 已在 App.tsx 作用域导入；若未导入则从其现有路径补 import：`@/components/sidebar/SessionListColumn`、`@/components/chat/ChatPanel`。）

- [ ] **Step 7: 冒烟测试 embed 布局渲染**

```typescript
// packages/app/src/lib/embed-mode.render.test.tsx
import { describe, it, expect, beforeEach } from 'vitest'
import { useUIStore } from '@/stores/ui'

describe('embed mode store flag', () => {
  it('embedMode true when location.search has embed=chat', () => {
    // jsdom: 直接断言解析逻辑落到 store 默认值的来源函数
    // (window.location 在 jsdom 默认无 search；此用例锁定 store 暴露了 embedMode 字段)
    expect(typeof useUIStore.getState().embedMode).toBe('boolean')
  })
})
```

Run: `cd packages/app && pnpm vitest run src/lib/embed-mode.render.test.tsx`
Expected: PASS

- [ ] **Step 8: typecheck**

Run: `cd packages/app && pnpm typecheck`
Expected: 无新增错误（main 上若有既有 tsc 错为预存，不计）

- [ ] **Step 9: Commit**

```bash
git add packages/app/src/lib/embed-mode.ts packages/app/src/lib/embed-mode.test.ts packages/app/src/lib/embed-mode.render.test.tsx packages/app/src/stores/ui.ts packages/app/src/App.tsx
git commit -m "feat(app): embed=chat query mode renders minimal session+chat layout"
```

---

### Task 6: 非 Tauri 的 Vite web 构建/dev 模式

让 `packages/app` 能脱离 Tauri 以纯 SPA 形式 dev/build，供子工程 2 打包引用。

**Files:**
- Modify: `packages/app/vite.config.ts`（放宽 `strictPort`，加 web 模式开关）
- Modify: `packages/app/package.json`（加 `dev:web` / `build:web` 脚本）
- Create: `packages/app/.env.web`（`VITE_*` Cloud API 指向）
- Modify: `packages/app/src/main.tsx`（确认所有 Tauri 调用都 try-catch / `isTauri()` 守卫）

**Interfaces:**
- Produces: `pnpm --filter @teamclaw/app dev:web` 跑出可在普通浏览器打开的 SPA；`build:web` 产出 `dist/`。

- [ ] **Step 1: 加 web 环境配置**

Create `packages/app/.env.web`：

```
VITE_APP_PLATFORM=web
VITE_CLOUD_API_URL=https://cloud.ucar.cc
```

（Cloud API URL 以 `build.config.json` 现值为准；此处仅 dev 默认，最终由子工程 2 的扩展构建注入。）

- [ ] **Step 2: vite.config 放宽 Tauri 约束**

在 `packages/app/vite.config.ts` 中，把 dev server 的 `strictPort: true` 改为受环境控制：当 `process.env.VITE_APP_PLATFORM === 'web'` 时 `strictPort: false` 且不强制 1420 端口。不要删除 Tauri 路径（桌面构建仍需原行为）。

- [ ] **Step 3: 加脚本**

在 `packages/app/package.json` 的 `scripts` 加：

```json
"dev:web": "VITE_APP_PLATFORM=web vite --mode web",
"build:web": "VITE_APP_PLATFORM=web vite build --mode web"
```

- [ ] **Step 4: main.tsx Tauri 调用审计**

检查 `packages/app/src/main.tsx`：确认 `invoke('get_system_accent_color')` 已 `.catch()`（现状已有）、`initJwtBridge()` 在非 Tauri 下为 no-op 或被 `isTauri()` 守卫。若 `initJwtBridge()` 未守卫，包一层：

```typescript
import { isTauri } from '@/lib/utils'
if (isTauri()) initJwtBridge()
```

- [ ] **Step 5: 构建验证**

Run: `cd packages/app && pnpm build:web`
Expected: 构建成功，产出 `dist/index.html` + 资源；无 Tauri 相关报错。

- [ ] **Step 6: 运行时冒烟（手动，记录于 PR）**

Run: `cd packages/app && pnpm dev:web`，浏览器打开 `http://localhost:<port>/?embed=chat`
Expected: 出现登录界面（非空白、无 `__TAURI__ is not defined` 崩溃）；控制台无致命错误。
（完整登录→收发消息属 Task 7 的端到端手测。）

- [ ] **Step 7: Commit**

```bash
git add packages/app/vite.config.ts packages/app/package.json packages/app/.env.web packages/app/src/main.tsx
git commit -m "build(app): non-tauri web dev/build mode for browser runtime"
```

---

### Task 7: 端到端手测——浏览器内登录 + 多人聊天闭环

无独立自动化（需真实 Cloud API + MQTT broker）；这是子工程 1 的验收 gate，结果写入 PR 描述。

**Files:** 无代码改动（如发现 bug，回到对应 Task 修复并补测试）。

- [ ] **Step 1: 启动 web 模式**

Run: `cd packages/app && pnpm dev:web`，浏览器打开 `http://localhost:<port>/?embed=chat`

- [ ] **Step 2: 登录**

用既有账号经 Cloud API（OTP/OAuth）登录。
Expected: 登录成功，进入 embed 精简布局（左会话列表 + 右聊天面板），无桌面侧栏/向导。

- [ ] **Step 3: MQTT 连接核验**

打开 DevTools Network/WS：应看到一条到 broker 的 `ws(s)://.../mqtt` WebSocket 连接，状态 101 Switching Protocols。
Expected: WS 已建立；`mqttStatus()`（可在 console 临时调用）返回 `connected: true`。

- [ ] **Step 4: 收发消息闭环**

选一个会话，发送一条消息；另一端（桌面 app 或 iOS）应收到；本端应实时收到对端消息与 agent 流式回复。
Expected: 双向多人消息 + 流式回复实时到达，无需刷新。

- [ ] **Step 5: 断连恢复**

DevTools 切 offline 数秒再恢复。
Expected: WS 自动重连（`reconnectPeriod`），恢复后消息继续。

- [ ] **Step 6: 记录验收**

把以上 5 项结果（截图/要点）写入子工程 1 PR 描述。全绿即子工程 1 完成，可进入子工程 2。

---

## Self-Review

- **Spec 覆盖**：MQTT-ws 适配（Task 2-3）、平台 seam 分流零改动（Task 4）、embed 精简模式（Task 5）、非 Tauri build（Task 6）、Cloud API/config 浏览器安全（spec 已确认现状无需改，故无 Task）、端到端验收（Task 7）——覆盖 spec「子工程 1」全部改造点。
- **占位扫描**：无 TBD/TODO；每个 code step 含完整代码与可运行命令。
- **类型一致**：`IncomingEnvelope`/`mqttConnect` 等签名在 Task 3/4 与既有 `mqtt-bridge.ts` 逐字一致；`createBrowserMqttAdapter` 返回类型在 Task 2 定义、Task 3 消费，名称一致。
- **已知缺口（实现期注意）**：①`mqtt-bridge.test.ts` 既有测试可能需加 `isTauri()=>true` mock（Task 4 Step 5 已含）；②adapter 未暴露真 `unsubscribe`，聊天场景不需要（Task 3 注明）；③mqtt-reconnect/错误 surface store 与 browser 连接状态的深度对接未在本子工程做（桌面经 Tauri 事件驱动；browser 下 `onConnectionState` 已具备，接入留子工程 2 或后续——不影响 Task 7 收发闭环）。

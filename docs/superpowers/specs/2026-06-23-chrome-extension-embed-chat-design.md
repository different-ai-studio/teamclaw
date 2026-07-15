# Chrome 扩展：嵌入 TeamClaw 多人聊天 + 页面内容抓取

**日期**: 2026-06-23
**状态**: 设计已确认，待实现（拆为两个子工程）

## 目标

做一个 Chrome 扩展（Manifest V3），在浏览器侧边栏（side panel）里嵌入 TeamClaw 的多人
聊天窗口，并能把当前网页的内容（选中文本或全页正文）作为上下文发送给远端 daemon 上的
agent。主要场景：浏览自家 admin portal 时随手就当前页内容向 agent 提问/下任务。

## 非目标（YAGNI）

- 不做 agent 反控页面（点击/填表/导航，browser-use 式）—— 后续阶段再议。
- 不做结构化字段抽取 —— 先只抓可读文本。
- 扩展不直连 daemon HTTP，也不持有 daemon root token。
- 不引入 Mozilla Readability —— 正文先用 `innerText` 兜底。
- 不在扩展里复刻全量桌面功能（workspace / terminal / git / MCP / 文件编辑全部排除）。

## 连接架构

扩展**不直连 amuxd daemon**。daemon 的 HTTP API 只绑定 `127.0.0.1` + 文件 root token，
浏览器跨机器不可达。扩展沿用 web 前端 / expo 已有的通道：**Cloud API（HTTPS bearer）+
MQTT over WebSocket（实时流）**，daemon 在后端被间接驱动。daemon 零改动。

**承载方式：把 `@teamclaw/app` 的聊天子集直接打包进扩展**，作为 side panel 的
`chrome-extension://` 页面运行（无 iframe、无公网托管、无跨域 CSP 问题）。这要求 app 能在
**纯浏览器**（无 Tauri）环境跑起来——目前 app 是 Tauri 桌面应用，MQTT 走 Rust 桥。

```
┌─ Chrome 扩展 (Manifest V3) ──────────────────────────────┐
│  Side Panel 页面 = 打包后的 @teamclaw/app(embed 精简模式)  │
│     Cloud API(fetch) + MQTT over WebSocket(mqtt npm)      │
│                ▲   chrome.runtime 消息                    │
│  Service Worker (background)                              │
│   └─ 管理 side panel；调 content script 取页面；转发      │
│                ▲   chrome.runtime 消息                    │
│  Content Script (按需注入当前 tab)                        │
│   └─ 读取选中文本 / 全页 innerText + 标题/URL             │
└───────────────────────────────────────────────────────────┘
            │ HTTPS Cloud API + MQTT(ws)
            ▼
   Cloud API (cloud.ucar.cc) ──► 远端 amuxd daemon
```

## 子工程拆分

本设计拆为两个可独立验证的子工程，各自一份实现计划，顺序执行：

### 子工程 1：`@teamclaw/app` 浏览器运行时（依赖项，先做）

让 app 的多人聊天子集在**纯浏览器**跑起来，只走 Cloud API + MQTT-ws。
**独立验收**：普通浏览器 tab（`pnpm dev` 的 web 模式）里能登录、选会话、收发多人消息、看
到实时流式回复——全程无 Tauri。

现状评估（已调研）：
- Cloud API client(`src/lib/backend/cloud-api/`)、server-config、bootstrap、聊天 UI
  组件（`ChatPanel` 等）已是浏览器安全的纯 fetch/React，零改动。
- 已有 `isTauri()`（`src/lib/utils.ts`）守卫，大量 Tauri-only 操作在非 Tauri 下已优雅
  早退。
- **唯一硬骨头**：`src/lib/mqtt-bridge.ts` 100% 走 Tauri `invoke('mqtt_*')` + Tauri
  事件。需要一个浏览器 MQTT-ws 适配器（可移植 `apps/expo/src/lib/mqtt/expo-mqtt.ts`，
  它已用 `mqtt` npm 包 v5）。
- vite 已有可选 Tauri 插件 stub 机制（`vite.config.ts` 的 `tauri-plugin-mcp-stub`），
  可沿用思路给 mqtt-bridge 做平台分流。

关键改造点：
1. **平台抽象的 MQTT seam**：把 `mqtt-bridge.ts` 改为按 `isTauri()` 分流——Tauri 路径
   不变；浏览器路径用新 `mqtt-browser-bridge.ts`（`mqtt` npm over ws，移植自 expo），
   暴露同一组 `mqttConnect/mqttSubscribe/mqttPublish/listenForEnvelopes/mqttDisconnect`
   接口签名，使消费方零改动。
2. **embed 精简模式**：用 URL query 参数（如 `?embed=chat`）在启动时把 Zustand
   `useUIStore.currentView` 切到一个只渲染「会话列表 + 多人聊天面板」的精简布局，隐藏
   桌面专属侧栏 / daemon 管理 / setup 向导。
3. **浏览器 build target**：新增一个非 Tauri 的 Vite 构建/运行模式（放宽端口
   `strictPort`、`VITE_*` 注入 Cloud API URL、确保 `main.tsx` 的 Tauri 调用全部
   try-catch 或 `isTauri()` 守卫）。

### 子工程 2：Chrome 扩展外壳（依赖子工程 1）

把子工程 1 的浏览器 build 装进 MV3 扩展，加页面抓取。**独立验收**：装载未打包扩展，在真实
admin portal 里 抓取当前页 → 发送 → 看到 agent 回复 的闭环。

组成：
- `sidepanel.html` + side panel 页面：宿主，加载打包后的 app（embed 模式）+「抓取当前页」
  按钮。
- `background.ts`（service worker）：管理 side panel 开关；用 `chrome.scripting
  .executeScript` 向 active tab 取页面内容；在 content script ⇄ side panel 间转发消息。
- `content-script.ts`：抽取 `document.title`、`location.href`、`window.getSelection()`；
  无选中时取主体 `innerText` 兜底。
- Manifest V3：`permissions: [sidePanel, scripting, activeTab]`，`host_permissions`
  按需，`side_panel.default_path: sidepanel.html`。

## 消息协议（子工程 2，扩展内 chrome.runtime）

side panel 页面与 background/content script 同属扩展 origin，用 `chrome.runtime`
消息（非跨域 postMessage）：

```
sidepanel → background:  { type: 'request-page' }            // 用户点抓取
background → content:    executeScript 调取页面内容
content   → background:  { title, url, text, selection }
background → sidepanel:  { type: 'page-context', payload }   // 注入 app 输入框上下文
```

app（side panel 内）监听 `chrome.runtime.onMessage`，收到 `page-context` 后把文本作为
本条消息的上下文/附件发给 Cloud API → daemon agent。

## 认证

app 完全复用现有 Cloud API 登录（bearer + bootstrap 取 MQTT 凭证）。扩展本身不持有
token，不碰 daemon root token。首登在 side panel 页面内完成；token/团队上下文存
`localStorage`（扩展页面的持久 origin storage）。

## 错误处理

- MQTT-ws 连接失败：app 现有「未连接」错误 surface 沿用（见仓库 mqtt 错误上报机制）。
- side panel 页面未就绪前的抓取请求：background 缓存最近 1 条，页面 `ready` 后补发。
- content script 注入失败（`chrome://` / Web Store 等受限页）：side panel 显示「当前页
  不可抓取」。
- 非法/未知 `chrome.runtime` 消息：丢弃。

## 测试

- 子工程 1 单元：`mqtt-browser-bridge` 的 ws URL 映射（`mqtt://`→`ws://`、
  `mqtts://`→`wss://`）、连接/发布/订阅参数编解码、envelope 回调分发（mock `mqtt`
  包）；embed query 参数 → currentView 解析。复用 web app 既有 vitest（jsdom）。
- 子工程 1 冒烟：embed 模式渲染会话列表 + 聊天面板（`isTauri()===false`）。
- 子工程 2 单元：content script 抽取函数（jsdom，选中优先 / innerText 兜底 / 受限页）；
  `chrome.runtime` 消息协议编解码（mock `chrome`）。
- 手动：`pnpm dev` web 模式跑通登录→多人聊天（子工程 1）；装载未打包扩展在真实 admin
  portal 验证抓取→发送→回复闭环（子工程 2）。

## 待落地的开放项（实现期处理）

- 扩展项目落点：新建 `apps/extension/`（构建工具沿用 Vite，MV3 用
  `@crxjs/vite-plugin` 或 `wxt`，实现期定）。
- 子工程 1 的浏览器 build 产物如何被子工程 2 的 Vite 构建引用（同一 monorepo workspace
  依赖 `@teamclaw/app`，build 时一起打包）。
- embed 模式要不要独立精简 bundle（按需 code-split），还是整包加路由门控——先整包门控，
  体积优化留后。
- `mqtt` npm 包在 MV3 service worker / 扩展页面的 ws 兼容性实测（service worker 无
  `WebSocket`? → MQTT 应在 side panel 页面而非 service worker 里连，已按此设计）。

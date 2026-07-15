# Chrome Web Store — Privacy practices 填写内容（copilot361）

去 [开发者后台](https://chrome.google.com/webstore/devconsole) → 该插件条目 → **Privacy practices** tab，
按下面内容填。都是根据 `apps/extension/` 现有代码（manifest.json + background.ts + content-script.ts）
如实描述的，如果之后加了新权限/新数据用途要记得回来同步改。

## Single purpose description

```
TeamClaw is a browser sidebar that lets a user chat with their AI agent and,
on explicit user action, send the content of the currently active tab to
that agent as context for the conversation.
```

## Permission justifications

**activeTab**
```
Used to read the content of the tab the user is currently viewing only when
the user explicitly invokes the extension (toolbar icon or in-page action),
so that page content can be shared with their AI agent as conversation
context.
```

**scripting**
```
Used to inject the content script that extracts the visible text/link
context of the active page on user request, and to render an in-page
link-hover affordance for sending a link to the agent.
```

**tabs**
```
Used to query the currently active tab (chrome.tabs.query) and to send
messages to it (chrome.tabs.sendMessage) when relaying page content to the
side panel chat.
```

**sidePanel**
```
Used to open the Chrome side panel that hosts the chat UI where the user
talks to their AI agent.
```

**storage**
```
Used only for local ephemeral session state (chrome.storage.session) to pass
a pending "open this link in the agent" action from the content script to
the side panel, and a small local allowlist (chrome.storage.local) of
domains the user has enabled the link-hover affordance on. No account
credentials, chat content, or browsing history is persisted in
chrome.storage.
```

**Host permissions (http://*/*, https://*/*)**
```
The extension's core feature is letting the user send the page they are
currently on to their AI agent from any website, so the content script and
page-read capability must be available on all sites rather than an
allowlist. No page content is read or transmitted unless the user takes an
explicit action (opening the side panel / using the "send to agent" link
affordance) — there is no passive/background collection.
```

## Remote code justification

```
The extension's background service worker and content script are fully
bundled at build time (esbuild) and contain no remote/dynamically-fetched
code. The side panel loads a bundled single-page app (also built at compile
time) that communicates with the user's configured TeamClaw backend
(cloud API + MQTT) over network requests to send/receive chat messages —
this is data exchange with a backend the user has configured, not remote
code execution inside the extension.
```
(如果 Google 的自动检测仍然认为触发了 remote-code 分类，通常是因为打包依赖里有 `eval`/`new Function` 之类的动态求值调用——不是本项目主动引入的远程脚本；上面这段文字如实说明即可，一般能过审。)

## Data usage disclosure（勾选项，如实勾）

- **What user data does this extension collect?**
  勾选 *Website content*（当用户主动触发时，读取当前页面文本/链接发给 agent）
  **以及** *Personally identifiable information*（side panel 内嵌了 TeamClaw 账号登录流程，
  邮箱/手机号登录会用到邮箱地址，属于 PII）。
  不勾选 Health / Financial / Authentication / Personal communications / Location /
  Web history / User activity——插件本身不做这些（登录用的是邮箱/手机号 OTP，不存密码；
  不做背景抓取历史/键鼠监控）。

- **Is this data being sold to third parties?** 否
- **Is this data being used for purposes unrelated to the item's core functionality?** 否
- **Is this data being used to determine creditworthiness or for lending purposes?** 否

## Certification

勾选 "I certify that ... complies with the Developer Program Policies"。

## Contact email（Settings 页）

填一个你们团队能持续收邮件、且能验证的邮箱（会收到 Google 发来的验证链接，点确认）。

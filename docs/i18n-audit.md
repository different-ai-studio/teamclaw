# i18n 整体梳理（packages/app）

审计日期：2026-06-04 · 分支 `agent/i18n-review` · 范围 `packages/app/src`

i18n 栈：`react-i18next`，两种语言 `en` / `zh-CN`，键以 `.` 分隔嵌套，构建期可用
`VITE_LOCALE` 锁定单语言。配置见 `packages/app/src/lib/i18n.ts`。

## 总体结论

**结构非常健康，无运行时漏译。主要问题是历史累积的死键（约占 20%）。**

| 检查项 | 结果 |
|---|---|
| en / zh-CN 键数 | 2952 / 2952，完全对齐 |
| 一方缺失的键 | 0（双向） |
| 代码引用但 locale 缺失的键 | **0**（无运行时 missing-key） |
| 插值占位符 `{{x}}` 不匹配 | 0 |
| 值类型不匹配 | 0 |
| zh-CN 与 en 完全相同 | 74（多为专有名词/占位符，约 10 个真未翻译） |
| 高置信度死键（无任何静态引用） | **~570（约占 20%）** |
| 硬编码用户可见字符串 | ~26 处 / 12 文件 |

## 1. 死键（最大项，~570 个 / ~20%）

高置信度：全仓任何字符串字面量都搜不到该键路径；无 keyPrefix / 命名空间间接寻址；
动态构键仅 3 处（`actors.role.*`、`setupWizard.deps.*`，均已覆盖），无字符串拼接构键。

按命名空间分布（前列）：

```
settings   392    chat     33    nodeStatus 23    skillssh  22
app         17    common   11    auth       10    workspace  9
sidebar      9    navigation 8   knowledge   8    updater    7
```

典型死键来源：
- **已移除的后端**：`auth.pocketbasePreview*`、`auth.onboarding.supabase*`、
  `auth.onboarding.mqtt*`（supabase/pocketbase 后端已删，见 CLAUDE.md）。
- **重构掉的 UI**：`chat.send`/`chat.clear`/`chat.title`/`chat.inputPlaceholder`、
  `navigation.*`（home/chat/files/...）、`common.yes`/`common.no`/`common.ok` 等。

> 建议：按命名空间逐块复核后批量删除，不要无脑全删（极少数可能经异常路径引用）。

## 2. 真未翻译的 zh-CN 项（~10 个）

74 个「zh 与 en 相同」里绝大多数合理（Supabase / MQTT / MCP / Git / `sk-...` /
邮箱示例 / URL）。应翻译的少数：

- `auth.onboarding.joinTeam` = "Join the team" → 加入团队
- `sidebar.ideasSection` = "Top Ideas" / `ideas.allTitle` = "Ideas"
- `daemonRuntimes.live` = "Live" → 在线/实时
- `ideas.contextMenu.statusOpen` = "Open" → 进行中/打开
- `chat.actorSheet.title` = "Actors" / `chat.actorSheet.agentSection` = "AGENT"
- `settings.roles.roleSection` = "Role" → 角色

（其中部分可能已经是死键，删除优先于翻译。）

## 3. 硬编码用户可见字符串（~26 处 / 12 文件）

最严重：`settings/KnowledgeConfigPanel.tsx`（10 处：Top K / Base URL / API Key /
Rerank* 表单标签与 placeholder）。其它：

- `ui/sidebar.tsx`：`"Sidebar"`、`"Displays the mobile sidebar."`
- `ui/breadcrumb.tsx`：`"More"`(sr-only) · `permission/PermissionDialog.tsx`：`"Close"`(sr-only)
- `auth/LobsterLoader.tsx`：aria-label `"Loading"` · `tab-bar/TabBar.tsx`：aria-label `"close"`
- `chat/NewSessionDialog.tsx`：aria-label `"Remove participant"`
- `main-content/WebViewContent.tsx`：`"Failed to load page"`（错误文案）
- `tab-bar/FindInPageBar.tsx`：title `"Close (Escape)"` · `terminal/TerminalSearchOverlay.tsx`：`"Case sensitive"`
- `settings/team/EnableShareWizard.tsx`：`"OSS"` / `"HTTPS Token"`（部分是技术名词，可保留）

可保留（品牌/技术名词）：OSS、Jina AI、LangSearch、Compass、GitLab/Gitee、HTTPS Token。

## 4. 模式观察

- 大量 `t('key', 'English default')` 带默认值写法 —— 容错好，但会掩盖键漂移
  （键删了/拼错了也不报错，直接显示英文兜底）。死键之所以无害正源于此。
- 无 `keyPrefix` / 命名空间用法，键路径全用全名引用 —— 利于静态分析。

## 已执行的修复（本分支）

1. **删死键**：移除 589 个无引用键（locale 5326→约 4750 行，−1256 行）。删除前已
   验证无 keyPrefix 间接寻址、无字符串拼接构键、跨包（Rust/daemon/gateway）不按名
   引用 locale 键。
2. **补译**：翻译 19 个有把握的 UI 标签（沿用既有约定：Actor=成员、Workspace=工作区、
   Runtime=运行时、Idea=想法、Agent=智能体），技术名词/占位符/ID/URL 保留英文。
3. **修硬编码**：把 ~20 处真用户可见文案接入 `t()`（KnowledgeConfigPanel 表单标签、
   WebView 错误/标题、终端/查找/标签页/移除成员的 title/aria 等），新增 13 个键。
   有意保留 `ui/sidebar.tsx`、`ui/breadcrumb.tsx` 两个 shadcn 原语的 sr-only 样板
   （vendored UI 库），品牌/技术名词（OSS、Jina AI、OpenAI Compatible 等）保留字面量。
4. **补真缺失键**：守卫测试发现并修复 8 个 pre-existing 缺口 —— 企业微信向导 6 个
   `wizard*` 键（之前经 `titleKey/descKey` 引用却不在 locale，靠英文兜底）+ 权限
   `externalDirectory`/`skill` 标签；`wizardIntroDesc` 渲染补传 `appName` 插值。
5. **加守卫测试**：新增 `src/__tests__/i18n-parity.test.ts`（5 个用例）——
   ① en/zh 键集完全一致 ② 值类型一致 ③ 插值占位符一致
   ④ 无运行时缺失键（严格匹配 `t()`/`i18nKey`/`titleKey|descKey|labelKey`）
   ⑤ 无死键（广义引用 + 动态前缀白名单 `actors.role.`/`setupWizard.deps.` + 复数变体）。

验证：`pnpm --filter @teamclaw/app typecheck` 净；完整单测套件全绿（含修好的
`tab-bar.test.tsx` —— 该测试环境跑 zh-CN，原硬编码 `/close/i` 改为经 i18n 取实际标签）；
改动文件 ESLint 净。

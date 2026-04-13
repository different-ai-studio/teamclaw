# Wiki Links — Obsidian 兼容的双向链接

**日期：** 2026-04-10
**状态：** Draft
**范围：** knowledge/ 目录内部

## 目标

在 TeamClaw 的 knowledge/ 目录中实现 Obsidian 兼容的 `[[wiki link]]` 语法，让用户和 Agent 生成的知识笔记之间可以通过链接互相关联。纯前端方案，不改动 Rust RAG crate。

### 非目标

- Backlinks 面板（未来再做）
- 图谱可视化（未来再做）
- knowledge/ 以外的链接范围
- Agent 自动提取笔记（独立的 OpenCode plugin）

## 设计

### 1. 链接语法（Obsidian 兼容）

支持三种形式：

| 语法 | 含义 | 示例 |
|------|------|------|
| `[[pageName]]` | 链接到 knowledge/ 下文件名为 `pageName.md` 的笔记 | `[[Q2排期]]` |
| `[[pageName\|显示文本]]` | 带别名的链接 | `[[Q2排期\|二季度排期]]` |
| `[[pageName#heading]]` | 链接到具体标题 | `[[Q2排期#风险]]` |

**匹配规则（与 Obsidian 一致）：**

- 按文件名匹配（不含 `.md` 扩展名），大小写不敏感
- 不要求路径前缀：`[[排期]]` 可以匹配 `knowledge/project/排期.md`
- 同名文件存在时，选择路径最短（最浅层级）的文件
- 未匹配到文件时，渲染为红色虚线样式（表示"待创建"），点击触发创建流程

### 2. Tiptap Wiki Link Extension

新建一个 Tiptap extension 处理 `[[]]` 的输入、渲染和交互。

**文件位置：** `packages/app/src/components/editors/extensions/WikiLinkExtension.ts`

**核心行为：**

- **输入规则（inputRule）：** 用户输入 `[[` 时触发自动补全弹窗，显示 knowledge/ 下的文件列表，支持模糊搜索。选中后插入 `[[pageName]]` 节点。
- **解析（parseHTML）：** 从 Markdown 源文本中识别 `[[...]]` 模式，转换为自定义 inline node
- **渲染（renderHTML）：** 渲染为 `<span class="wiki-link" data-target="pageName">` 带样式的可点击元素
- **点击处理：** 点击链接时，查询文件映射表，在编辑器中打开目标文件
- **Markdown 序列化：** 通过 `@tiptap/markdown` 的 extension config 扩展点实现（`markdownTokenizer` + `parseMarkdown` + `renderMarkdown`）。底层解析器为 `marked`（非 markdown-it），编写自定义 inline tokenizer 识别 `[[...]]` token。不走 string pre/post processing，保持与 Obsidian 的兼容性

**节点 Schema：**

```typescript
{
  name: 'wikiLink',
  group: 'inline',
  inline: true,
  atom: true,
  attrs: {
    target: { default: '' },      // 目标页面名
    alias: { default: null },     // 显示文本（可选）
    heading: { default: null },   // 目标标题（可选）
  },
}
```

### 3. Knowledge 文件映射表

在 knowledge store 中维护一个 `title → filePath` 的映射，供链接解析使用。

**文件位置：** 扩展 `packages/app/src/stores/knowledge.ts`

**数据结构：**

```typescript
interface WikiLinkIndex {
  // 文件名（不含扩展名）→ 相对路径
  // 如果同名，存路径最短的
  fileMap: Map<string, string>;
}
```

**构建时机：**

- 应用启动时，从 knowledge/ 目录扫描所有 `.md` 文件构建
- 监听 `knowledge-index-changed` 事件（现有 file watcher 已有），增量更新映射表
- 不需要额外的 watcher，复用现有 RAG watcher 的事件

**API：**

```typescript
// 解析 wiki link 目标
resolveWikiLink(target: string): string | null;

// 获取所有页面名（用于自动补全）
getAllPageNames(): string[];

// 创建新笔记（未匹配时）
createNoteFromLink(pageName: string): Promise<string>;
```

### 4. 自动补全弹窗

用户输入 `[[` 后弹出浮动面板，列出 knowledge/ 下的文件供选择。

**行为：**

- 输入 `[[` 后立即显示，继续输入文字进行模糊过滤
- 显示文件名 + 所在子目录（如 `Q2排期 — project/`）
- 上下键选择，Enter 确认，Esc 关闭
- 选中后插入完整的 `[[pageName]]` 节点
- 输入 `]]` 时自动关闭弹窗并确认当前输入（即使没有匹配到已有文件）

**实现：** 使用 Tiptap 的 `@tiptap/suggestion` 插件（与 mention 功能类似），复用现有的弹窗 UI 模式。

### 5. 渲染样式

```css
/* 已解析的链接 */
.wiki-link {
  color: var(--color-primary);
  text-decoration: underline;
  text-decoration-style: dotted;
  cursor: pointer;
}
.wiki-link:hover {
  text-decoration-style: solid;
}

/* 未解析的链接（目标文件不存在） */
.wiki-link--unresolved {
  color: var(--color-muted);
  text-decoration: underline;
  text-decoration-style: dashed;
  opacity: 0.6;
}
```

### 6. "创建笔记"流程

点击未解析的 `[[pageName]]` 时：

1. 在 `knowledge/` 根目录下创建 `pageName.md`
2. 写入默认 frontmatter：
   ```markdown
   ---
   title: pageName
   created: 2026-04-10T10:00:00Z
   updated: 2026-04-10T10:00:00Z
   ---

   ```
3. 在编辑器中打开新文件
4. 更新文件映射表

### 7. Knowledge Sidebar（left dock tab）

在 left dock 新增一个 "Knowledge" tab，复用现有 `FileBrowser` / `FileTree` 组件，作用域限定为 `knowledge/` 目录。

**入口：** left dock panel tab 栏新增一个 Knowledge 图标（`BookOpen` 或 `Library`），与现有 Shortcuts / Files tab 并列。

**改造 FileBrowser：** 添加可选的 `rootPath` prop，默认为 workspace root。Knowledge tab 传入 `${workspacePath}/knowledge`。

**顶部工具栏（4 个图标按钮）：**

| 图标 | 功能 | 说明 |
|------|------|------|
| `FilePlus` | 新建笔记 | 在当前选中目录（或 knowledge/ 根）下创建 `.md` 文件，写入默认 frontmatter |
| `FolderPlus` | 新建文件夹 | 在当前选中目录下创建子目录 |
| `ArrowUpDown` | 排序切换 | 切换排序方式：按名称（默认）/ 按修改时间 |
| `ChevronsDownUp` | 全部折叠 | 调用 `collapseAll()` 收起所有展开的目录 |

**复用的能力（零改动）：**
- 虚拟滚动（大目录性能）
- 展开/折叠目录
- 单击打开文件
- 右键上下文菜单（重命名、删除、复制等）
- 文件图标

**不显示的信息（knowledge 场景不需要）：**
- Git 状态标记
- 团队同步状态

**文件位置：** `packages/app/src/components/knowledge/KnowledgeBrowser.tsx`（新建，薄 wrapper）

### 8. RAG 搜索集成

不改动 Rust 侧搜索逻辑。在前端展示搜索结果时：

- 搜索结果的 chunk content 中如果包含 `[[...]]`，用正则提取并渲染为可点击的 wiki link 样式
- 这样用户从搜索结果中也能直接跳转到关联笔记

## 文件清单

| 文件 | 操作 | 说明 |
|------|------|------|
| `packages/app/src/components/editors/extensions/WikiLinkExtension.ts` | 新建 | Tiptap wiki link 扩展（含 markdown-it plugin） |
| `packages/app/src/components/editors/extensions/WikiLinkSuggestion.tsx` | 新建 | 自动补全弹窗组件 |
| `packages/app/src/components/knowledge/KnowledgeBrowser.tsx` | 新建 | Knowledge sidebar wrapper（工具栏 + FileBrowser） |
| `packages/app/src/stores/knowledge.ts` | 修改 | 添加 WikiLinkIndex 和解析方法 |
| `packages/app/src/components/editors/TiptapMarkdownEditor.tsx` | 修改 | 注册 WikiLink extension |
| `packages/app/src/components/knowledge/KnowledgeSearchPreview.tsx` | 修改 | 搜索结果中渲染 wiki links |
| `packages/app/src/components/workspace/FileBrowser.tsx` | 修改 | 添加 `rootPath` prop 支持 |
| `packages/app/src/App.tsx` | 修改 | left dock 新增 Knowledge tab |

## 设计决策

| 决策 | 选择 | 理由 |
|------|------|------|
| Markdown 序列化 | 扩展 `@tiptap/markdown`（marked custom tokenizer） | 一等公民方案，复制粘贴等边缘场景自动 work，不额外增加 string pre/post processing 管道 |
| Node 类型 | `atom: true` inline node | 不可编辑但实现简单；修改需删除重建，v1 可接受 |
| 同名文件 | 选路径最短的 | Obsidian 会提示选择，v1 简化处理 |
| 新建笔记位置 | `knowledge/` 根目录 | v1 简化，未来可加目录选择器 |
| 搜索结果渲染 | 正则提取 `[[]]` 并排除代码块 | 避免误渲染代码示例中的 wiki link 语法 |
| Knowledge sidebar | 复用 FileBrowser + left dock tab | 零新组件树，只加薄 wrapper 和 `rootPath` prop；隐藏 git/sync 状态 |

## Obsidian 兼容性

### 完全兼容

| 操作 | 说明 |
|------|------|
| 文件读写 | 双方都是普通 `.md` 文件操作，完全等价 |
| `[[page]]` / `[[page\|alias]]` / `[[page#heading]]` | 双方语法一致，按文件名匹配 |
| 文件夹结构 | 原生文件系统目录，双方共享 |
| 标准 Markdown 图片 `![](path)` | 双方都能渲染 |

### 有差异（不影响数据安全）

| 差异 | TeamClaw v1 | Obsidian |
|------|-------------|----------|
| 重命名时自动更新链接 | 不支持（旧链接变为未解析状态） | 自动更新所有引用 |
| `![[embed]]` 嵌入引用 | 显示为纯文本 | 内联渲染 |
| `[[page^block-id]]` 块引用 | 不支持 | 支持 |
| Frontmatter | 创建笔记时写入 `title`/`created`/`updated` | 默认不写，但能识别 |

### 图片存储兼容

TeamClaw 将图片保存到与 Markdown 文件同级的 `_assets/` 目录，使用标准 `![](\_assets/xxx.png)` 语法。

Obsidian 默认将附件存到 vault 根目录，需要配置才能与 TeamClaw 完全等价。

**推荐 Obsidian 配置（双向使用时）：**

> Settings → Files & Links：
> - **Use [[Wikilinks]]** → 保持开启（关闭后 Obsidian 会用 `[text](path.md)` 代替 `[[]]`，我们不会识别为 wiki link）
> - **Default location for new attachments** → "Subfolder under current folder"
> - **Subfolder name** → `_assets`
> - **New link format** → "Relative path to file"

配置后双方插入的图片存储路径和 Markdown 引用语法完全一致。未配置时，Obsidian 仍能**显示** TeamClaw 插入的图片（标准 Markdown 语法），只是 Obsidian 新插入的图片位置会不同。

## 测试策略

- **单元测试：** wiki link 解析函数（各种语法变体、同名文件优先级、大小写）
- **单元测试：** 文件映射表的构建和增量更新
- **手动测试：** Tiptap 中输入 `[[`、自动补全、点击跳转、创建新笔记
- **兼容性测试：** 用 Obsidian 打开同一个 knowledge/ 目录，验证链接双向可用

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
- **Markdown 序列化：** 保存时原样输出 `[[pageName]]` 文本，保持与 Obsidian 的兼容性

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

### 7. RAG 搜索集成

不改动 Rust 侧搜索逻辑。在前端展示搜索结果时：

- 搜索结果的 chunk content 中如果包含 `[[...]]`，用正则提取并渲染为可点击的 wiki link 样式
- 这样用户从搜索结果中也能直接跳转到关联笔记

## 文件清单

| 文件 | 操作 | 说明 |
|------|------|------|
| `packages/app/src/components/editors/extensions/WikiLinkExtension.ts` | 新建 | Tiptap wiki link 扩展 |
| `packages/app/src/components/editors/extensions/WikiLinkSuggestion.tsx` | 新建 | 自动补全弹窗组件 |
| `packages/app/src/stores/knowledge.ts` | 修改 | 添加 WikiLinkIndex 和解析方法 |
| `packages/app/src/components/editors/TiptapMarkdownEditor.tsx` | 修改 | 注册 WikiLink extension |
| `packages/app/src/components/knowledge/KnowledgeSearchPreview.tsx` | 修改 | 搜索结果中渲染 wiki links |

## 测试策略

- **单元测试：** wiki link 解析函数（各种语法变体、同名文件优先级、大小写）
- **单元测试：** 文件映射表的构建和增量更新
- **手动测试：** Tiptap 中输入 `[[`、自动补全、点击跳转、创建新笔记
- **兼容性测试：** 用 Obsidian 打开同一个 knowledge/ 目录，验证链接双向可用

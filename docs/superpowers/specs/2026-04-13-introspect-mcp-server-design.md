# Introspect MCP Server — AI 能力自省与执行

**Date:** 2026-04-13
**Status:** Draft

## Problem

TeamClaw 有大量用户可配置的能力（消息频道、角色、快捷键、定时任务等），但 AI agent 在对话时完全不知道这些配置的存在。当用户说"帮我通过企微发条消息"，AI 无法知道 WeCom channel 是否已绑定、团队有哪些成员、环境里配置了什么。

更关键的是，即使 AI 知道了有哪些能力，也无法执行关键操作——比如通过已绑定的 channel 发送消息。底层发送函数（`DeliveryManager`）已经完整实现了所有 channel 的发送逻辑，但只被 cron 系统内部使用，没有暴露给 AI agent。

## Solution

实现一个内置 MCP server（`teamclaw-introspect`），提供四个工具：
1. **`get_my_capabilities`** — 发现：查询用户已配置的能力和设置信息
2. **`send_channel_message`** — 执行：通过已绑定的 channel 发送消息
3. **`manage_cron_job`** — 管理：创建、暂停、恢复、删除定时任务
4. **`manage_shortcuts`** — 管理：创建、修改、删除快捷操作

**核心选型决策：**

| 决策 | 选择 | 原因 |
|------|------|------|
| 注入方式 | 按需查询（非自动注入 system prompt） | 不浪费 token，只在需要时查询 |
| 实现机制 | MCP tool（非前端拦截） | 架构干净，符合 MCP 规范，AI 天然发现 |
| 工具粒度 | 单工具 + 可选 category 参数 | 兼顾全局概览和精准查询 |
| 实现语言 | Rust（嵌入 Tauri） | 数据在文件系统，Rust 直接读取，无需跨进程 |
| 注册方式 | 启动时自动注册 | 对用户透明，无需手动配置 |

## Design

### 1. MCP Tool Definition

```json
{
  "name": "get_my_capabilities",
  "description": "查询当前用户在 TeamClaw 中配置的能力和设置。当用户提到发消息、查团队、用快捷键、看定时任务等操作时，先调用此工具了解可用能力。不传 category 返回所有类别的概览摘要。",
  "inputSchema": {
    "type": "object",
    "properties": {
      "category": {
        "type": "string",
        "enum": ["channels", "role", "shortcuts", "team_members", "env_vars", "team_info", "cron_jobs"],
        "description": "可选，按类别过滤。不传则返回全部概览。"
      }
    }
  }
}
```

### 2. MCP Tool Definition — `send_channel_message`

```json
{
  "name": "send_channel_message",
  "description": "通过已绑定的消息频道发送消息。支持指定单个 channel 或广播到所有已绑定 channel。发送前请先调用 get_my_capabilities 确认 channel 绑定状态。",
  "inputSchema": {
    "type": "object",
    "properties": {
      "channel": {
        "type": "string",
        "enum": ["wecom", "discord", "email", "feishu", "kook", "wechat", "all"],
        "description": "目标频道。传 'all' 广播到所有已绑定的频道。"
      },
      "message": {
        "type": "string",
        "description": "要发送的消息内容（纯文本）。"
      },
      "target": {
        "type": "string",
        "description": "接收者标识。格式因 channel 而异：WeCom 'single:{userid}' 或 'group:{chatid}'；Discord 'dm:{user_id}' 或 'channel:{channel_id}'；Email 邮箱地址；Feishu chat_id；KOOK 'dm:{user_id}' 或 'channel:{channel_id}'；WeChat user_id。channel='all' 时为可选，不传则使用各 channel 的默认目标。"
      }
    },
    "required": ["channel", "message"]
  }
}
```

#### 执行逻辑

**单 channel 发送 (`channel` != `"all"`):**
1. 从 `teamclaw.json` 读取该 channel 配置
2. 校验 channel 已绑定（必填字段存在）
3. 调用 `DeliveryManager::send_notification()` 发送
4. 返回发送结果（成功/失败及错误信息）

**广播发送 (`channel` = `"all"`):**
1. 从 `teamclaw.json` 读取所有 channel 配置
2. 过滤出已绑定的 channel
3. 逐个调用 `DeliveryManager::send_notification()`
4. 返回每个 channel 的发送结果

```json
// 广播返回示例
{
  "results": {
    "wecom": { "success": true },
    "email": { "success": true, "message_id": "abc123@gmail.com" },
    "discord": { "success": false, "error": "Bot token expired" }
  },
  "summary": "2/3 channels sent successfully"
}
```

#### Target 解析规则

| Channel | Target 格式 | 默认值（不传时） |
|---------|------------|----------------|
| wecom | `single:{userid}` / `group:{chatid}` / `{userid}` | 无默认，必须指定 |
| discord | `dm:{user_id}` / `channel:{channel_id}` | 无默认，必须指定 |
| email | 邮箱地址 | 无默认，必须指定 |
| feishu | chat_id | 无默认，必须指定 |
| kook | `dm:{user_id}` / `channel:{channel_id}` | 无默认，必须指定 |
| wechat | user_id | 无默认，必须指定 |

**注意:** `channel="all"` 时 `target` 为可选。如果不传 target，各 channel 使用 `teamclaw.json` 中配置的默认接收者（如有）。如果某个 channel 无默认接收者且未传 target，则跳过该 channel 并在结果中标注。

#### 复用 DeliveryManager

`send_channel_message` 底层直接复用已有的 `DeliveryManager`（`src-tauri/src/commands/cron/delivery.rs`）：

- `DeliveryManager` 已封装所有 6 个 channel 的发送逻辑
- 每次发送时重新读取 `teamclaw.json` 配置（自动感知配置变更）
- 内置消息分片（Discord 2000 字符、WeCom/Feishu 4000 字符、KOOK 8000 字符）
- 内置 UTF-8 安全的分割逻辑

MCP server 只需创建 `DeliveryManager` 实例并调用 `send_notification()`，不需要重新实现任何发送逻辑。

#### 用户场景示例

**场景 1:** "帮我给企微发条消息，告诉张三明天开会"
```
AI → get_my_capabilities(category="channels")  → 发现 wecom 已绑定
AI → get_my_capabilities(category="team_members") → 找到张三的 userid
AI → send_channel_message(channel="wecom", target="single:zhangsan", message="明天开会，请准时参加")
```

**场景 2:** "给我所有 channel 发一条消息：系统维护通知"
```
AI → get_my_capabilities(category="channels") → 发现 wecom + email 已绑定
AI → send_channel_message(channel="all", message="系统维护通知：今晚 22:00-23:00 进行系统升级")
→ 返回: wecom ✅, email ✅ (其他未绑定跳过)
```

### 3. MCP Tool Definition — `manage_cron_job`

```json
{
  "name": "manage_cron_job",
  "description": "管理定时任务：创建、暂停、恢复、删除、手动执行、查看运行历史。先用 get_my_capabilities(category='cron_jobs') 了解已有任务。",
  "inputSchema": {
    "type": "object",
    "properties": {
      "action": {
        "type": "string",
        "enum": ["create", "pause", "resume", "delete", "run", "get_runs"],
        "description": "操作类型"
      },
      "job_id": {
        "type": "string",
        "description": "目标任务 ID。create 时不需要，其他操作必须提供。"
      },
      "name": {
        "type": "string",
        "description": "任务名称。create 时必须提供。"
      },
      "description": {
        "type": "string",
        "description": "任务描述。create 时可选。"
      },
      "schedule": {
        "type": "object",
        "description": "调度配置。create 时必须提供。",
        "properties": {
          "kind": {
            "type": "string",
            "enum": ["at", "every", "cron"],
            "description": "调度类型：at=一次性定时、every=固定间隔、cron=cron 表达式"
          },
          "at": {
            "type": "string",
            "description": "kind=at 时，ISO 8601 时间戳"
          },
          "every_ms": {
            "type": "number",
            "description": "kind=every 时，间隔毫秒数"
          },
          "expr": {
            "type": "string",
            "description": "kind=cron 时，5 段 cron 表达式（如 '0 9 * * *'）"
          },
          "tz": {
            "type": "string",
            "description": "可选 IANA 时区（如 'Asia/Shanghai'），默认系统本地时区"
          }
        }
      },
      "message": {
        "type": "string",
        "description": "任务执行时发送给 AI 的 prompt。create 时必须提供。"
      },
      "delivery": {
        "type": "object",
        "description": "可选，任务结果推送配置。",
        "properties": {
          "channel": {
            "type": "string",
            "enum": ["discord", "feishu", "email", "kook", "wechat", "wecom"]
          },
          "to": {
            "type": "string",
            "description": "推送目标（同 send_channel_message 的 target 格式）"
          }
        }
      }
    },
    "required": ["action"]
  }
}
```

#### 各 Action 行为

| Action | 必须参数 | 底层调用 | 说明 |
|--------|---------|---------|------|
| `create` | name, schedule, message | `CronStorage::add_job()` | 创建任务，自动生成 ID，计算 next_run_at |
| `pause` | job_id | `CronStorage::toggle_enabled(id, false)` | 暂停任务 |
| `resume` | job_id | `CronStorage::toggle_enabled(id, true)` | 恢复任务，重新计算 next_run_at |
| `delete` | job_id | `CronStorage::remove_job(id)` | 删除任务及运行历史 |
| `run` | job_id | `CronScheduler::execute_job()` | 立即手动触发一次执行 |
| `get_runs` | job_id | `CronStorage::get_runs(id, 10)` | 查看最近 10 条运行记录 |

#### 返回示例

**create 返回:**
```json
{
  "success": true,
  "job": {
    "id": "550e8400-e29b-41d4-a716-446655440000",
    "name": "每日站会提醒",
    "enabled": true,
    "schedule": "0 9 * * * (Asia/Shanghai)",
    "next_run_at": "2026-04-14T01:00:00Z"
  }
}
```

**get_runs 返回:**
```json
{
  "runs": [
    {
      "run_id": "run-1",
      "status": "success",
      "started_at": "2026-04-13T01:00:00Z",
      "finished_at": "2026-04-13T01:02:30Z",
      "summary": "已发送站会提醒到企业微信群"
    }
  ]
}
```

#### 用户场景示例

**场景:** "帮我看看有多少定时任务，把那个日报任务暂停掉，然后新建一个每周一早上9点的周报任务"
```
AI → get_my_capabilities(category="cron_jobs")
     → 返回: 3个任务 (日报id=abc, 周会提醒id=def, 数据备份id=ghi)

AI → manage_cron_job(action="pause", job_id="abc")
     → 返回: 日报任务已暂停

AI → manage_cron_job(action="create", name="周报", description="每周一生成周报",
       schedule={kind:"cron", expr:"0 9 * * 1", tz:"Asia/Shanghai"},
       message="请生成本周工作周报，总结本周完成的任务和下周计划",
       delivery={channel:"wecom", to:"group:weekly-report"})
     → 返回: 任务创建成功，下次执行 2026-04-14T01:00:00Z
```

### 4. MCP Tool Definition — `manage_shortcuts`

```json
{
  "name": "manage_shortcuts",
  "description": "管理用户的快捷操作：创建、修改、删除。快捷操作可以是原生命令、链接或文件夹。先用 get_my_capabilities(category='shortcuts') 了解已有快捷操作。",
  "inputSchema": {
    "type": "object",
    "properties": {
      "action": {
        "type": "string",
        "enum": ["create", "update", "delete"],
        "description": "操作类型"
      },
      "id": {
        "type": "string",
        "description": "快捷操作 ID。update/delete 时必须提供。"
      },
      "label": {
        "type": "string",
        "description": "显示名称。create 时必须提供。"
      },
      "type": {
        "type": "string",
        "enum": ["native", "link", "folder"],
        "description": "类型：native=内置命令、link=外部链接、folder=文件夹。create 时必须提供。"
      },
      "target": {
        "type": "string",
        "description": "目标：native 时为命令内容，link 时为 URL。create 时必须提供（folder 可为空）。"
      },
      "icon": {
        "type": "string",
        "description": "可选，图标标识。"
      },
      "parent_id": {
        "type": "string",
        "description": "可选，父文件夹 ID。不传则放在根级别。"
      }
    },
    "required": ["action"]
  }
}
```

#### 各 Action 行为

| Action | 必须参数 | 说明 |
|--------|---------|------|
| `create` | label, type, target | 创建快捷操作，自动生成 ID 和 order |
| `update` | id + 要修改的字段 | 修改已有快捷操作的任意字段 |
| `delete` | id | 删除快捷操作（如为 folder 则同时删除子项） |

#### 返回示例

```json
{
  "success": true,
  "shortcut": {
    "id": "shortcut-1713000000-abc1234",
    "label": "日报",
    "type": "native",
    "target": "请帮我生成今日工作日报"
  }
}
```

### 5. Category 定义与数据源

#### `channels` — 已绑定的消息频道

**数据源:** `{workspace}/.opencode/teamclaw.json` → `channels` 字段

**返回内容:**
```json
{
  "channels": {
    "wecom": { "bound": true, "corp_name": "XX公司", "agent_name": "TeamClaw" },
    "discord": { "bound": false },
    "email": { "bound": true, "address": "user@example.com", "provider": "gmail" },
    "feishu": { "bound": false },
    "kook": { "bound": false },
    "wechat": { "bound": false }
  }
}
```

**规则:**
- `bound` 通过检查关键必填字段是否存在来判断（如 WeCom 需要 `corp_id` + `agent_id` + `secret`）
- 返回帮助 AI 理解频道用途的摘要字段（如 corp_name），不返回 token/secret

#### `role` — 当前角色

**数据源:** `{workspace}/.opencode/roles/*/ROLE.md` + 前端选中状态

**返回内容:**
```json
{
  "current_role": {
    "slug": "product-assistant",
    "name": "产品助理",
    "description": "协助产品需求分析和文档撰写",
    "working_style": "结构化输出，先分析再建议",
    "skills": ["需求分析", "PRD撰写"]
  },
  "available_roles": [
    { "slug": "dev-assistant", "name": "开发助手" },
    { "slug": "product-assistant", "name": "产品助理" }
  ]
}
```

**注意:** 当前选中的 role 信息需要从 OpenCode sidecar 或配置文件中获取。如果选中状态仅在前端内存中，则只返回 `available_roles` 列表，不返回 `current_role`。

#### `shortcuts` — 用户自定义快捷操作

**数据源:** `{workspace}/.opencode/teamclaw.json` → `shortcuts` 字段

**返回内容:**
```json
{
  "shortcuts": [
    { "id": "shortcut-1713000000-abc", "label": "日报", "type": "native", "target": "请帮我生成今日工作日报" },
    { "id": "shortcut-1713000001-def", "label": "周报", "type": "native", "target": "汇总本周工作" }
  ]
}
```

#### `team_members` — 团队成员

**数据源:** `{workspace}/opencode-team/_team/members.json`

**返回内容:**
```json
{
  "members": [
    { "name": "张三", "role": "editor", "label": "后端开发" },
    { "name": "李四", "role": "viewer", "label": "产品经理" }
  ]
}
```

**规则:** 只返回 name、role、label。不返回 node_id、platform、arch 等技术字段。

#### `env_vars` — 环境变量

**数据源:** `{workspace}/.opencode/teamclaw.json` → `envVars` 字段（元数据索引）

**返回内容:**
```json
{
  "env_vars": [
    { "key": "OPENAI_API_KEY", "description": "OpenAI API密钥", "category": "system" },
    { "key": "CUSTOM_TOKEN", "description": "自定义服务Token", "category": null }
  ]
}
```

**安全规则:** 只返回 key 名和 description，**绝不返回 value**。从 `teamclaw.json` 的元数据索引读取，不访问 keychain。

#### `team_info` — 团队信息

**数据源:** `{workspace}/.opencode/teamclaw.json` → `team` 字段

**返回内容:**
```json
{
  "team": {
    "enabled": true,
    "sync_mode": "oss",
    "git_url": "https://github.com/org/team-repo",
    "last_sync_at": "2026-04-13T10:30:00Z"
  }
}
```

**规则:** 不返回 `git_token`。

#### `cron_jobs` — 定时任务

**数据源:** `{workspace}/.opencode/cron-jobs.json`

**返回内容:**
```json
{
  "cron_jobs": [
    {
      "id": "uuid-1",
      "name": "每日站会提醒",
      "description": "每天早上9点发送站会提醒",
      "enabled": true,
      "schedule": "0 9 * * *",
      "last_run_at": "2026-04-13T01:00:00Z",
      "next_run_at": "2026-04-14T01:00:00Z"
    }
  ]
}
```

**规则:** 返回任务摘要信息，不返回完整的 payload 和 delivery 配置。

### 5. 无 category 时的概览响应

不传 `category` 参数时，返回精简的全局概览：

```json
{
  "overview": {
    "channels": { "bound": ["wecom", "email"], "unbound": ["discord", "feishu", "kook", "wechat"] },
    "role": { "current": "产品助理", "available_count": 3 },
    "shortcuts": { "count": 5, "names": ["日报", "周报", "代码审查", "..."] },
    "team_members": { "count": 4, "names": ["张三", "李四", "..."] },
    "env_vars": { "count": 3, "keys": ["OPENAI_API_KEY", "CUSTOM_TOKEN", "..."] },
    "team_info": { "enabled": true, "sync_mode": "oss" },
    "cron_jobs": { "count": 2, "enabled_count": 1 }
  }
}
```

概览用于 AI 快速了解全局情况，再通过 category 参数查询详细信息。

### 6. MCP Server 架构

#### 进程模型

内置 MCP server 作为一个 stdio MCP server 实现，由 Tauri 应用启动时 spawn 为子进程。

```
TeamClaw App 启动
  ↓
Tauri setup hook → spawn teamclaw-introspect 子进程 (stdio MCP)
  ↓
自动写入 opencode.json 的 mcpServers 配置
  ↓
OpenCode sidecar 读取配置 → 连接 MCP server
  ↓
AI 对话时在工具列表中看到 get_my_capabilities + send_channel_message
```

#### 实现方式

在 `src-tauri/` 中新建一个 Rust binary target `teamclaw-introspect`：

```
src-tauri/
  src/
    bin/
      teamclaw-introspect.rs   ← MCP server binary entry
  src/
    introspect/
      mod.rs                   ← MCP server 逻辑 + tools/list + tools/call 路由
      capabilities.rs          ← get_my_capabilities 实现（7 个 category 读取）
      send.rs                  ← send_channel_message 实现（复用 DeliveryManager）
      cron.rs                  ← manage_cron_job 实现（复用 CronStorage + CronScheduler）
      shortcuts.rs             ← manage_shortcuts 实现（读写 teamclaw.json）
```

#### MCP 协议实现

使用 `rmcp` crate（Rust MCP SDK）实现 stdio 传输的 MCP server：

- 监听 stdin，响应写入 stdout
- 实现 `tools/list` → 返回 4 个工具定义
- 实现 `tools/call` → 按工具名路由到对应处理逻辑
- workspace 路径通过命令行参数传入

#### 自动注册

Tauri 启动时：

1. 将 `teamclaw-introspect` binary 打包为 sidecar（与 OpenCode sidecar 类似）
2. 在 `opencode.json` 的 `mcpServers` 中注入配置：
   ```json
   {
     "mcpServers": {
       "teamclaw-introspect": {
         "command": "{path_to_binary}",
         "args": ["--workspace", "{workspace_path}"],
         "type": "local"
       }
     }
   }
   ```
3. OpenCode sidecar 启动后自动发现并连接

### 7. Shortcuts 持久化迁移

个人 shortcuts 当前存在 localStorage，需要迁移到文件系统，使其与团队 shortcuts 一致，MCP server 也能直接读写。

**迁移方案:**

1. **新增 Tauri commands:**
   - `save_shortcuts(nodes: ShortcutNode[])` — 写入 `teamclaw.json` → `shortcuts` 字段
   - `load_shortcuts() → ShortcutNode[]` — 从 `teamclaw.json` 读取

2. **前端 store 改造:**
   - `shortcuts.ts` 的 `loadPersistedNodes()` 改为调用 `invoke('load_shortcuts')`
   - `persistNodes()` 改为调用 `invoke('save_shortcuts', { nodes })`
   - 移除 localStorage 的读写逻辑

3. **一次性迁移:** 首次启动时，如果 `teamclaw.json` 中无 `shortcuts` 字段但 localStorage 有数据，则读取 localStorage 写入 `teamclaw.json`，完成迁移后清除 localStorage 中的旧数据。

4. **Source of truth:** 迁移后 `teamclaw.json` → `shortcuts` 为唯一数据源，前端和 MCP server 都从这里读写，不存在同步问题。

### 8. 安全规则汇总

| 数据 | 返回 | 不返回 |
|------|------|--------|
| channels | bound 状态、名称、基本描述 | token、secret、webhook URL |
| role | 名称、描述、工作风格、技能列表 | 完整 markdown body |
| shortcuts | 名称、描述、触发词 | — |
| team_members | 名称、角色、标签 | node_id、platform、arch、hostname |
| env_vars | key 名、description、category | **value（绝不返回）** |
| team_info | enabled、sync_mode、git_url | git_token |
| cron_jobs | 名称、描述、schedule、enabled、时间 | payload、delivery 详细配置 |

### 9. 错误处理

**get_my_capabilities:**
- 配置文件不存在 → 返回该 category 为空/默认值，不报错
- JSON 解析失败 → 返回错误信息，标记该 category 为 `"error"`
- 无效 category 参数 → 返回错误提示，列出可用的 category 值

**send_channel_message:**
- channel 未绑定 → 返回错误：`"WeCom channel is not bound. Please configure it in Settings → Channels."`
- target 未提供且无默认值 → 返回错误：`"Target is required for {channel}. Format: {expected_format}"`
- 发送失败（网络/认证） → 返回底层错误信息，AI 可告知用户具体原因
- `channel="all"` 部分失败 → 不中断，返回每个 channel 的独立结果

**manage_cron_job:**
- job_id 不存在 → 返回错误：`"Job not found: {job_id}"`
- create 缺少必填字段 → 返回错误，列出缺失字段
- 无效 cron 表达式 → 返回解析错误信息
- run 触发失败 → 返回执行错误，不影响任务本身状态

**manage_shortcuts:**
- id 不存在 → 返回错误：`"Shortcut not found: {id}"`
- create 缺少必填字段 → 返回错误，列出缺失字段
- delete folder → 同时删除所有子项，返回删除数量

## Scope

### In Scope
- `teamclaw-introspect` Rust binary（MCP server）
- `get_my_capabilities` 工具实现（7 个 category）
- `send_channel_message` 工具实现（复用 DeliveryManager，支持单发和广播）
- `manage_cron_job` 工具实现（复用 CronStorage + CronScheduler，6 种操作）
- `manage_shortcuts` 工具实现（CRUD 快捷操作）
- 个人 shortcuts 从 localStorage 迁移到 `teamclaw.json`（含一次性数据迁移）
- 自动注册到 `opencode.json` 的 mcpServers
- Tauri 启动时 spawn MCP server 子进程

### Out of Scope
- 修改 AI 的 system prompt（保持现状）
- 其他写入操作的 MCP 工具（如修改配置、管理 cron）
- 前端 UI 变更（MCP server 对用户透明）
- 发送富文本/附件（仅支持纯文本消息）

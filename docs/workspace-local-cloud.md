# Workspace：本地文件与云端如何写入、如何使用

> 简明模型说明。已知分叉/重复问题见  
> [`docs/superpowers/specs/2026-07-01-workspace-identity-split-investigation.md`](superpowers/specs/2026-07-01-workspace-identity-split-investigation.md)

---

## 1. 两套存储，各管什么

```
┌─────────────────────────────┐         ┌─────────────────────────────┐
│  本机 ~/.amuxd/workspaces.toml │         │  云端 amux.workspaces 表      │
│  （daemon 进程读写）           │         │  （FC / Cloud API）           │
├─────────────────────────────┤         ├─────────────────────────────┤
│  path          真实目录       │         │  path          目录（镜像）   │
│  workspace_id  本地 8 位 id   │  remote │  id            云 UUID       │
│  remote_workspace_id ────────┼────────►│  agent_id      绑定的 agent   │
│  team_id       team-share 用 │         │  team_id       所属团队       │
│  display_name                 │         │  name                          │
└─────────────────────────────┘         └─────────────────────────────┘
         │                                         │
         └──────── runtimeStart 靠 id 桥接 ────────┘
```

| 存储 | 谁需要 | 解决什么问题 |
|------|--------|--------------|
| **本地文件** | daemon | 本机哪个目录跑 agent；MQTT `runtimeStart` 解析 path |
| **云端表** | 客户端、会话、统计 | 跨设备统一的 workspace 身份；列表、绑定 agent、历史 runtime |

**原则**：客户端只认识 **云 UUID**；daemon 只在本机 **path** 上起进程。`remote_workspace_id` 是两者之间的映射。

---

## 2. 本地文件怎么写入

**文件**：`~/.amuxd/workspaces.toml`  
**唯一写入方**：**amuxd daemon**（客户端通过 RPC/HTTP 触发，不直接改文件）。

### 写入入口

| 触发方 | 调用 | daemon 内部 |
|--------|------|-------------|
| Desktop / 任意客户端 | MQTT `addWorkspace(path)` | `apply_add_workspace` |
| Desktop HTTP | `POST /v1/workspaces` | 转给 daemon actor，同上 |
| daemon 启动 | 当前工作目录 | `workspaces.add` + sync（若配置） |

### 单次 `addWorkspace` 做了什么

```
1. workspaces.add(path)
   · 按 path 去重：已有则复用，不新建行
   · 新 path → 生成 workspace_id（8 位随机）

2. stamp_daemon_team
   · 仅当 team_id 为空时，写入 daemon.toml 的 team_id
   · 已有 team_id → 不覆盖（换团队后可能变陈旧）

3. sync_workspace_to_cloud
   · POST /v1/workspaces 到云端
   · 若 remote_workspace_id 为空 → 不带 id，云端 INSERT 新 UUID
   · 成功 → 把返回的 id 写入 remote_workspace_id

4. workspaces.save → 落盘 workspaces.toml
```

### 本地一行长什么样

```toml
[[workspaces]]
workspace_id = "0eecd57e"              # daemon 本地 id
remote_workspace_id = "aa923c64-..."   # 云端 workspaces.id（sync 后才有）
path = "/Users/you/project/foo"
display_name = "foo"
team_id = "68c9c97a-..."               # team-share；首次 add 时 stamp
```

---

## 3. 云端怎么写入

**表**：`amux.workspaces`  
**入口**：`POST /v1/workspaces`（FC `upsertWorkspace`，按 **id** 冲突，**不按 path 去重**）。

### 写入来源（当前有两条独立链路）

| 来源 | 谁调 | 典型字段 | 代码 |
|------|------|----------|------|
| **A. 客户端 UI** | Desktop `createDaemonWorkspace` | `teamId`, `agentId`, `path`, `name` | `LocalDaemonRow`, `DaemonWorkspacesSection` |
| **B. daemon sync** | `sync_workspace_to_cloud` | `teamId`, `agentId`(daemon), `path`, `name` | `apps/daemon/.../server.rs` |

Desktop 添加 workspace 时 **常做两步**（两条链路各写一次云）：

```
createDaemonWorkspace()   →  云端 INSERT 一行（带 agent 绑定）
addWorkspace(path)        →  daemon 本地 + sync 再 INSERT 一行
```

两步 **不传同一个 cloud id** → 同 path 可能出现两个云 UUID（已知问题）。

### 云端一行主要字段

| 字段 | 用途 |
|------|------|
| `id` | 客户端 `runtimeStart`、会话、列表用的 UUID |
| `path` | 该 workspace 对应的文件系统路径（可为 null，如 `General` 占位） |
| `agent_id` | 绑定到哪个 agent actor |
| `team_id` | 属于哪个团队 |

其他写入：`PATCH /v1/workspaces/:id` 改名/归档；`PUT /v1/agents/:id/defaults` 设 agent 默认 workspace。

---

## 4. 云端怎么被使用（读）

| 场景 | API / 逻辑 | 取什么 |
|------|------------|--------|
| 侧边栏 workspace 列表 | `GET /v1/workspaces?teamId&agentId` | 展示、切换 |
| 解析 runtime 用哪个云 id | `loadAgentWorkspaceLookups` | 见下表优先级 |
| 按 id 查 path | `POST /v1/workspaces/by-ids` | `ensureDaemonWorkspaceRegistered` |
| agent 默认 | `agents.default_workspace_id` | 解析 fallback |

**`runtimeStart` 选云 UUID 的优先级**（`resolveAgentRuntimeWorkspaceId`）：

1. 发送时传入的 hint  
2. 本会话该 agent 上次 runtime 的 `workspace_id`  
3. `agents.default_workspace_id`  
4. `workspaces` 表里 `agent_id` 匹配的第一条  

---

## 5. 本地文件怎么被使用（读）

| 场景 | 谁读 | 怎么用 |
|------|------|--------|
| **起 agent runtime** | daemon `runtime_lifecycle` | `find_by_id(客户端传来的 id)` → 得到 **path**，在目录里跑 ACP |
| **列本机 workspace** | MQTT `fetchWorkspaces` | 返回本地 `workspace_id` + `path`（不给客户端 `remote_workspace_id`） |
| **默认 cwd / cron** | daemon `default_workspace_path` | 读 `default_workspace_id` 或唯一 workspace |
| **team-share** | daemon team-link | 读每行的 `team_id` + `path` 做 symlink / 全局目录 |

### `find_by_id` 规则（runtime 核心）

客户端发来的 `workspaceId` 可以是：

- 本地 `workspace_id`（8 位），或  
- 云 `remote_workspace_id`（UUID）

任一匹配 → 解析到 **path**。都不匹配且没传 `worktree` → `WORKSPACE_NOT_FOUND`。

---

## 6. 端到端：Desktop 本机 agent 发消息

```
Desktop 选中 path（workspaceStore.workspacePath）
        │
        ▼
解析云 UUID（path 匹配 cloud 表，或 owned/default）
        │
        ▼
ensureDaemonWorkspaceRegistered（仅 Tauri + 本机 agent）
  · fetchWorkspaces → 本机是否已有该 path
  · 没有 → addWorkspace(path) → 更新 toml + sync 云
  · 有   → 按 path 匹配，返回本地 workspace_id
        │
        ▼
runtimeStart(targetActorId, workspaceId=本地id或云UUID)
        │
        ▼
daemon find_by_id → path → 在该目录启动 agent
```

## 7. 端到端：插件 / Web（含本机 MACPRO）

```
解析云 UUID（常落到 agent 绑定的 workspaces 行）
        │
        ▼
ensureDaemonWorkspaceRegistered  ← 当前跳过（!isTauri）
        │
        ▼
runtimeStart(workspaceId=云 UUID)
        │
        ▼
daemon 必须在 remote_workspace_id 或 workspace_id 里认得这个 UUID
```

插件没有本地 `workspacePath`，完全依赖 **云 UUID ↔ daemon 本地映射** 一致。

---

## 8. 对照小结

| 问题 | 本地 `workspaces.toml` | 云端 `workspaces` |
|------|------------------------|-------------------|
| **谁写** | 仅 daemon | 客户端 UI **或** daemon sync |
| **主键** | `workspace_id`（8 位）+ path 去重 | `id`（UUID） |
| **桥接字段** | `remote_workspace_id` | `id`（应一致，常不一致） |
| **runtime 真正用的** | `path` | 不直接跑 agent，只提供 id |
| **多 workspace** | 多个 `[[workspaces]]`，每个 path 一行 | 多行；同 path 可重复（无唯一约束） |

---

## 9. 设计意图 vs 当前缺口（一句话）

**意图**：云 UUID 是跨端身份；本地 toml 是 daemon 的 path 注册表；`remote_workspace_id` 连接二者。

**缺口**：Desktop 与 daemon **各建一行云记录**且不握手；换团队 **不更新** 本地 `team_id`；非 Tauri 客户端 **不做 ensure** → 云 UUID 与本地映射分叉时会 `WORKSPACE_NOT_FOUND`。

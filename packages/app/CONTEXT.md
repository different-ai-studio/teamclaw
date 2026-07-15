# Desktop Context

Tauri 桌面端（`apps/desktop/` + `packages/app/`）的领域语言。
仅术语，不含实现细节。Actor/Participant 等跨端实体的权威定义在 `proto` context（`proto/teamclaw.proto`），此处仅注明在 desktop 端的使用约定。

## Glossary

### Actor
Team 内的**身份实体**。proto 权威定义：
```
Actor { actor_id, actor_type, display_name, owner_member_id }
ActorType: HUMAN | PERSONAL_AGENT | ROLE_AGENT
```
PERSONAL_AGENT 属个人，ROLE_AGENT 属团队角色。

### Participant
[Actor](#actor) 作为成员**加入**某个 [Session](#session)，含 `joined_at` 快照。
非 Actor 本身，是 Actor ↔ Session 的关联实例。

### Session
跨端一致：用户与一个或多个 agent / 人的会话。
代码中 `session-*-store` 系列围绕同一 sessionId 组织（messages、participants、permissions、selection 等）。

### AttachedAgent
用户在 prompt 输入框当前 **@-mention / 附加**的 agent —— **UI 选择状态**，不是 proto 实体。
代码中曾以 "EngagedAgent" 出现，统一以 **AttachedAgent** 为准（更中性，与 "engaged" 的歧义"投入中/参战中"区分）。
列表存于 `engaged-agent-store`（待重命名 `attached-agent-store`），一个 Session 可附加多个 AttachedAgent。

### Permission
agent 发起敏感操作（写文件、执行命令等）时通过 ACP `session/request_permission` 向用户发起的**授权请求**。
desktop 接收后弹 UI，用户的选择回写为 PermissionOutcome。
区别于 `collab` 的成员权限（team 层面）—— 此 Permission 是 per-turn 的运行时授权。

### Workspace
用户在 desktop 端**打开的本地目录**，是 desktop 端最外层的工作单元。
持有 file watcher、FileNode 树、`.teamclaw/` 元数据目录、可选的 team 共享 git 仓库子目录。
区别于：
- [Session](#session)（会话，可在 Workspace 内创建多个）
- Team（团队层身份，跨 Workspace）
- ACP session working dir（Runtime 工作目录，可能与 Workspace 一致也可能不一致）

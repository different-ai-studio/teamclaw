# 登录后 Daemon 团队 Onboarding (Block ④) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 用户登录后,桌面 app 自动检测本机 daemon 是否已 onboard;未 onboard 则弹向导让用户**新建 agent**(名字+可见性)或**绑定已有 agent**,后台跑 `amuxd init` + `amuxd install-service` 完成绑定与启动;daemon 已绑定的 team 与登录 team 不一致时**强制重置**(`amuxd clear --force`)后重走。

**Architecture:** 登录后在 `AuthGate` 的 bootstrap-ready 之后插一个 daemon-onboarding gate。app 用已有 `getBackend().teams.createTeamInvite`(kind=agent,绑定时带 targetActorId)拿 invite token → 新增 Tauri 命令跑捆绑的 `amuxd`(sidecar)执行 `init <teamclaw://invite?token=...>`(解析 stdout 拿 actorId)、`install-service`、`clear --force`。"新建 personal" 在 init 后调新增的 `makeAgentPersonal(actorId)` provider 方法(claim 默认 team)。状态机由新 store `stores/daemon-onboarding.ts` 驱动。

**Tech Stack:** Rust/Tauri 2(tauri-plugin-shell sidecar)、React 19 + Zustand、Vitest、node:test。

**依赖:** Block ②(amuxd sidecar + `install-service`/`clear` CLI)、Block ③(invite 端点 owner 校验 + rebind)、Block ①(amuxd 装到 `~/.amuxd/bin`)均已完成。

**范围/非目标:** 不在本块调 `POST /v1/team/link`(它需 workspace path + daemon HTTP 起来,已由 team-share enable/join 流程在 `stores/team-share.ts` / `JoinTeamFlow.tsx` 调用;onboarding 只负责绑定+启动 daemon)。不改 daemon 侧 Rust(init/clear/service 已存在)。

---

## File Structure

新增:
- `apps/desktop/src/commands/daemon_onboarding.rs` — Tauri 命令:`daemon_init`(跑 `amuxd init`,解析 actorId/teamId)、`daemon_install_service`、`daemon_clear`。含纯函数 `parse_init_outcome`。
- `packages/app/src/stores/daemon-onboarding.ts` — onboarding 状态机 store + 纯函数 `computeOnboardingStatus`。
- `packages/app/src/stores/__tests__/daemon-onboarding.test.ts` — `computeOnboardingStatus` 单测。
- `packages/app/src/components/auth/DaemonOnboardingWizard.tsx` — 向导 UI(新建/绑定/重置)。

修改:
- `apps/desktop/src/commands/mod.rs` — 加 `pub mod daemon_onboarding;`。
- `apps/desktop/src/lib.rs` — `invoke_handler!` 加 3 个命令。
- `packages/app/src/lib/backend/types.ts` — `ActorsBackend` 加 `makeAgentPersonal(agentId)`。
- `packages/app/src/lib/backend/cloud-api/actors.ts` — 实现 `makeAgentPersonal`。
- `packages/app/src/components/auth/AuthGate.tsx` — bootstrap-ready 之后插 daemon-onboarding gate。

不动:`get_daemon_team_id`/`get_daemon_http_info`(已存在,复用);`DaemonGeneralSection.tsx`(被动 mismatch 提示保留;强制重置在 gate 里处理)。

> **测试命令:** Rust 桌面 `cargo test -p teamclaw --lib daemon_onboarding::tests`;前端 `pnpm --filter @teamclaw/app exec vitest run <file>`;前端类型 `pnpm --filter @teamclaw/app typecheck`;FC 不涉及。

---

## Part R — Tauri 命令(跑 amuxd)

### Task 1: parse_init_outcome 纯函数 + daemon_init 命令

**Files:**
- Create: `apps/desktop/src/commands/daemon_onboarding.rs`
- Modify: `apps/desktop/src/commands/mod.rs`

- [ ] **Step 1: 写失败测试**

`apps/desktop/src/commands/daemon_onboarding.rs`:

```rust
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_actor_and_team_from_init_stdout() {
        let stdout = "\n✓ Daemon onboarded.\n  actor_id      = 11111111-1111-1111-1111-111111111111\n  team_id       = 22222222-2222-2222-2222-222222222222\n  display_name  = Build Bot\n  backend.toml  = /home/x/.amuxd/backend.toml\n\nNext: `amuxd start`";
        let out = parse_init_outcome(stdout).unwrap();
        assert_eq!(out.actor_id, "11111111-1111-1111-1111-111111111111");
        assert_eq!(out.team_id, "22222222-2222-2222-2222-222222222222");
    }

    #[test]
    fn returns_none_when_missing() {
        assert!(parse_init_outcome("nothing here").is_none());
    }
}
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cargo test -p teamclaw --lib daemon_onboarding::tests 2>&1 | tail -15`
Expected: `cannot find function parse_init_outcome`.

- [ ] **Step 3: 写实现(纯解析 + 命令)**

`apps/desktop/src/commands/daemon_onboarding.rs` 顶部:

```rust
use serde::Serialize;
use tauri::{AppHandle, Runtime};
use tauri_plugin_shell::process::CommandEvent;
use tauri_plugin_shell::ShellExt;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DaemonInitResult {
    pub actor_id: String,
    pub team_id: String,
}

/// Parse `amuxd init` stdout. Lines look like `  actor_id      = <uuid>` (multiple
/// spaces around `=`), so split on the FIRST `=` and trim both sides.
fn parse_init_outcome(stdout: &str) -> Option<DaemonInitResult> {
    let mut actor_id: Option<String> = None;
    let mut team_id: Option<String> = None;
    for line in stdout.lines() {
        if let Some((key, val)) = line.split_once('=') {
            let key = key.trim();
            let val = val.trim().to_string();
            if key == "actor_id" {
                actor_id = Some(val);
            } else if key == "team_id" {
                team_id = Some(val);
            }
        }
    }
    match (actor_id, team_id) {
        (Some(a), Some(t)) if !a.is_empty() && !t.is_empty() => {
            Some(DaemonInitResult { actor_id: a, team_id: t })
        }
        _ => None,
    }
}

/// Run the bundled `amuxd init <invite_url>`, capturing stdout to extract the
/// claimed actor/team ids. The daemon itself POSTs /v1/invites/claim.
#[tauri::command]
pub async fn daemon_init<R: Runtime>(
    app: AppHandle<R>,
    invite_url: String,
) -> Result<DaemonInitResult, String> {
    let (mut rx, _child_guard) = app
        .shell()
        .sidecar("amuxd")
        .map_err(|e| format!("sidecar amuxd: {e}"))?
        .args(["init", &invite_url])
        .spawn()
        .map_err(|e| format!("spawn amuxd init: {e}"))?;

    let mut stdout_buf = String::new();
    let mut stderr_buf = String::new();
    let mut exit_code: Option<i32> = None;
    while let Some(event) = rx.recv().await {
        match event {
            CommandEvent::Stdout(bytes) => stdout_buf.push_str(&String::from_utf8_lossy(&bytes)),
            CommandEvent::Stderr(bytes) => stderr_buf.push_str(&String::from_utf8_lossy(&bytes)),
            CommandEvent::Terminated(payload) => exit_code = Some(payload.code.unwrap_or(-1)),
            _ => {}
        }
    }
    if exit_code != Some(0) {
        return Err(format!(
            "amuxd init failed (code {:?}): {}",
            exit_code,
            stderr_buf.trim()
        ));
    }
    parse_init_outcome(&stdout_buf)
        .ok_or_else(|| format!("could not parse amuxd init output: {}", stdout_buf.trim()))
}
```

Add `pub mod daemon_onboarding;` to `apps/desktop/src/commands/mod.rs` (near `pub mod daemon_http;` / `pub mod daemon_installer;`).

- [ ] **Step 4: 运行测试确认通过**

Run: `cargo test -p teamclaw --lib daemon_onboarding::tests 2>&1 | tail -10`
Expected: 2 passed.

- [ ] **Step 5: 提交**

```bash
cd /Volumes/openbeta/workspace/teamclaw-v2/.worktrees/unified-install-onboarding
git branch --show-current   # must be agent/unified-install-onboarding
git add apps/desktop/src/commands/daemon_onboarding.rs apps/desktop/src/commands/mod.rs
git commit -m "feat(desktop): daemon_init command + init-output parser"
```

---

### Task 2: daemon_install_service + daemon_clear 命令 + handler 注册

**Files:**
- Modify: `apps/desktop/src/commands/daemon_onboarding.rs`
- Modify: `apps/desktop/src/lib.rs`

> 这两个是 side-effecting sidecar 调用,无单测;靠编译 + 手测。

- [ ] **Step 1: 加两个命令**

追加到 `apps/desktop/src/commands/daemon_onboarding.rs`:

```rust
/// Run `amuxd <args>` to completion, returning Err with stderr on non-zero exit.
async fn run_amuxd<R: Runtime>(app: &AppHandle<R>, args: &[&str]) -> Result<(), String> {
    let (mut rx, _child_guard) = app
        .shell()
        .sidecar("amuxd")
        .map_err(|e| format!("sidecar amuxd: {e}"))?
        .args(args)
        .spawn()
        .map_err(|e| format!("spawn amuxd {}: {e}", args.join(" ")))?;
    let mut stderr_buf = String::new();
    let mut exit_code: Option<i32> = None;
    while let Some(event) = rx.recv().await {
        match event {
            CommandEvent::Stderr(bytes) => stderr_buf.push_str(&String::from_utf8_lossy(&bytes)),
            CommandEvent::Terminated(payload) => exit_code = Some(payload.code.unwrap_or(-1)),
            _ => {}
        }
    }
    if exit_code != Some(0) {
        return Err(format!(
            "amuxd {} failed (code {:?}): {}",
            args.join(" "),
            exit_code,
            stderr_buf.trim()
        ));
    }
    Ok(())
}

/// Register amuxd as a user-level background service and start it.
#[tauri::command]
pub async fn daemon_install_service<R: Runtime>(app: AppHandle<R>) -> Result<(), String> {
    run_amuxd(&app, &["install-service"]).await
}

/// Wipe local daemon state (daemon.toml/backend.toml/etc) for a clean re-onboard.
#[tauri::command]
pub async fn daemon_clear<R: Runtime>(app: AppHandle<R>) -> Result<(), String> {
    run_amuxd(&app, &["clear", "--force"]).await
}
```

- [ ] **Step 2: 注册到 handler**

在 `apps/desktop/src/lib.rs` 的 `invoke_handler!` 列表(setup 命令旁,约 366-370 区域)加:

```rust
            commands::daemon_onboarding::daemon_init,
            commands::daemon_onboarding::daemon_install_service,
            commands::daemon_onboarding::daemon_clear,
```

- [ ] **Step 3: 编译检查**

Run: `cargo check -p teamclaw 2>&1 | tail -15`
Expected: 无 error(`daemon_onboarding.rs` 不应有新 warning)。

- [ ] **Step 4: 提交**

```bash
git add apps/desktop/src/commands/daemon_onboarding.rs apps/desktop/src/lib.rs
git commit -m "feat(desktop): daemon install-service / clear commands"
```

---

## Part A — Cloud API provider(makeAgentPersonal)

### Task 3: makeAgentPersonal provider 方法

**Files:**
- Modify: `packages/app/src/lib/backend/types.ts`(`ActorsBackend` 接口,约 437-464)
- Modify: `packages/app/src/lib/backend/cloud-api/actors.ts`

> 新建 agent 经 claim 默认 visibility='team';"新建 personal" 需 onboarding 后调 `/v1/agents/:id/make-personal`(iOS 验证过、supabase+pg 都支持的专用端点;PATCH visibility 在 supabase 不可靠,不用)。

- [ ] **Step 1: 读现状,确认 client.post 与接口位置**

Run: `sed -n '110,140p' packages/app/src/lib/backend/cloud-api/actors.ts && grep -n "ActorsBackend" packages/app/src/lib/backend/types.ts`
确认:`client.post<T>(path, body)` 用法(如 `updateOwnedAgentProfile` 用 PATCH;listConnectedAgents 用 GET),以及 `ActorsBackend` 接口里现有方法签名风格(`makeAgentPersonal` 加在那)。

- [ ] **Step 2: 接口加方法**

在 `packages/app/src/lib/backend/types.ts` 的 `ActorsBackend` 接口里(与 `updateOwnedAgentProfile`/`listConnectedAgents` 并列)加:

```ts
  makeAgentPersonal(agentActorId: string): Promise<void>;
```

- [ ] **Step 3: 实现**

在 `packages/app/src/lib/backend/cloud-api/actors.ts` 返回的对象里(与现有方法并列)加:

```ts
    async makeAgentPersonal(agentActorId: string): Promise<void> {
      await client.post<void>(
        `/v1/agents/${encodeURIComponent(agentActorId)}/make-personal`,
        {},
      );
    },
```

(若该文件的 `client.post` 泛型/签名不同,以文件里现有 POST 调用的写法为准;`/make-personal` 返回 204 空体。)

- [ ] **Step 4: typecheck**

Run: `pnpm --filter @teamclaw/app typecheck 2>&1 | tail -10`
Expected: 无 actors.ts / types.ts 相关错误。

- [ ] **Step 5: 提交**

```bash
git add packages/app/src/lib/backend/types.ts packages/app/src/lib/backend/cloud-api/actors.ts
git commit -m "feat(app): makeAgentPersonal cloud-api method"
```

---

## Part F — 前端状态机 + 向导

### Task 4: daemon-onboarding store + 状态计算测试

**Files:**
- Create: `packages/app/src/stores/daemon-onboarding.ts`
- Create: `packages/app/src/stores/__tests__/daemon-onboarding.test.ts`

- [ ] **Step 1: 写失败测试**

`packages/app/src/stores/__tests__/daemon-onboarding.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { computeOnboardingStatus } from '../daemon-onboarding'

describe('computeOnboardingStatus', () => {
  it('unknown when no current team yet', () => {
    expect(computeOnboardingStatus(null, null)).toBe('unknown')
    expect(computeOnboardingStatus('t1', null)).toBe('unknown')
  })
  it('needs-onboard when daemon has no team', () => {
    expect(computeOnboardingStatus(null, 't1')).toBe('needs-onboard')
  })
  it('ready when daemon team matches current team', () => {
    expect(computeOnboardingStatus('t1', 't1')).toBe('ready')
  })
  it('mismatch when daemon team differs from current team', () => {
    expect(computeOnboardingStatus('t2', 't1')).toBe('mismatch')
  })
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm --filter @teamclaw/app exec vitest run src/stores/__tests__/daemon-onboarding.test.ts 2>&1 | tail -15`
Expected: 失败 `Cannot find module '../daemon-onboarding'`.

- [ ] **Step 3: 写实现**

`packages/app/src/stores/daemon-onboarding.ts`:

```ts
import { create } from 'zustand'
import { isTauri } from '@/lib/utils'
import { getBackend } from '@/lib/backend'
import { useCurrentTeamStore } from '@/stores/current-team'

export type OnboardingStatus = 'unknown' | 'needs-onboard' | 'mismatch' | 'ready'
export type Visibility = 'team' | 'personal'

export type OwnedAgent = { agentId: string; displayName: string; visibility: string }

/** Pure status from daemon-bound teamId vs the logged-in current teamId. */
export function computeOnboardingStatus(
  daemonTeamId: string | null,
  currentTeamId: string | null,
): OnboardingStatus {
  if (!currentTeamId) return 'unknown'
  if (!daemonTeamId) return 'needs-onboard'
  return daemonTeamId === currentTeamId ? 'ready' : 'mismatch'
}

type DaemonOnboardingState = {
  status: OnboardingStatus
  loaded: boolean
  busy: boolean
  error: string | null
  ownedAgents: OwnedAgent[]
  refresh: () => Promise<void>
  loadOwnedAgents: () => Promise<void>
  createNewAgent: (name: string, visibility: Visibility) => Promise<void>
  bindExistingAgent: (agentId: string, displayName: string) => Promise<void>
  forceReset: () => Promise<void>
}

async function daemonTeamId(): Promise<string | null> {
  if (!isTauri()) return null
  const { invoke } = await import('@tauri-apps/api/core')
  return (await invoke<string | null>('get_daemon_team_id')) ?? null
}

/** Run create-invite → amuxd init → install-service. Returns the claimed agentId. */
async function onboard(teamId: string, displayName: string, targetActorId: string | null): Promise<string> {
  const { invoke } = await import('@tauri-apps/api/core')
  const invite = await getBackend().teams.createTeamInvite({
    teamId,
    kind: 'agent',
    displayName,
    agentKind: 'claude',
    ttlSeconds: null,
    targetActorId,
  })
  const inviteUrl = `teamclaw://invite?token=${encodeURIComponent(invite.token)}`
  const result = await invoke<{ actorId: string; teamId: string }>('daemon_init', { inviteUrl })
  await invoke('daemon_install_service')
  return result.actorId
}

export const useDaemonOnboardingStore = create<DaemonOnboardingState>((set, get) => ({
  status: 'unknown',
  loaded: false,
  busy: false,
  error: null,
  ownedAgents: [],

  refresh: async () => {
    if (!isTauri()) {
      set({ status: 'ready', loaded: true })
      return
    }
    const currentTeamId = useCurrentTeamStore.getState().team?.id ?? null
    const dTeam = await daemonTeamId()
    set({ status: computeOnboardingStatus(dTeam, currentTeamId), loaded: true })
  },

  loadOwnedAgents: async () => {
    const teamId = useCurrentTeamStore.getState().team?.id
    if (!teamId) return
    const rows = await getBackend().actors.listConnectedAgents(teamId)
    set({
      ownedAgents: rows
        .filter((r: any) => r.isOwner ?? r.is_owner)
        .map((r: any) => ({
          agentId: r.agentId ?? r.agent_id ?? r.id,
          displayName: r.displayName ?? r.display_name ?? '',
          visibility: r.visibility ?? 'team',
        })),
    })
  },

  createNewAgent: async (name, visibility) => {
    const teamId = useCurrentTeamStore.getState().team?.id
    if (!teamId) { set({ error: 'no current team' }); return }
    set({ busy: true, error: null })
    try {
      const agentId = await onboard(teamId, name, null)
      if (visibility === 'personal') {
        await getBackend().actors.makeAgentPersonal(agentId)
      }
      await get().refresh()
    } catch (e) {
      set({ error: String(e) })
    } finally {
      set({ busy: false })
    }
  },

  bindExistingAgent: async (agentId, displayName) => {
    const teamId = useCurrentTeamStore.getState().team?.id
    if (!teamId) { set({ error: 'no current team' }); return }
    set({ busy: true, error: null })
    try {
      await onboard(teamId, displayName, agentId)
      await get().refresh()
    } catch (e) {
      set({ error: String(e) })
    } finally {
      set({ busy: false })
    }
  },

  forceReset: async () => {
    if (!isTauri()) return
    set({ busy: true, error: null })
    try {
      const { invoke } = await import('@tauri-apps/api/core')
      await invoke('daemon_clear')
      await get().refresh()
    } catch (e) {
      set({ error: String(e) })
    } finally {
      set({ busy: false })
    }
  },
}))
```

- [ ] **Step 4: 运行测试确认通过**

Run: `pnpm --filter @teamclaw/app exec vitest run src/stores/__tests__/daemon-onboarding.test.ts 2>&1 | tail -10`
Expected: 4 passed.

- [ ] **Step 5: 提交**

```bash
git add packages/app/src/stores/daemon-onboarding.ts packages/app/src/stores/__tests__/daemon-onboarding.test.ts
git commit -m "feat(app): daemon-onboarding store + status reducer"
```

---

### Task 5: DaemonOnboardingWizard 组件

**Files:**
- Create: `packages/app/src/components/auth/DaemonOnboardingWizard.tsx`

- [ ] **Step 1: 写组件**

`packages/app/src/components/auth/DaemonOnboardingWizard.tsx`(Editorial Calm,沿用 SetupWizard 容器风格):

```tsx
import * as React from 'react'
import { Loader2, AlertCircle } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { useDaemonOnboardingStore, type Visibility } from '@/stores/daemon-onboarding'

export function DaemonOnboardingWizard({ onDone }: { onDone: () => void }) {
  const { status, busy, error, ownedAgents, refresh, loadOwnedAgents, createNewAgent, bindExistingAgent, forceReset } =
    useDaemonOnboardingStore()
  const [mode, setMode] = React.useState<'new' | 'bind'>('new')
  const [name, setName] = React.useState('')
  const [visibility, setVisibility] = React.useState<Visibility>('team')

  React.useEffect(() => {
    void refresh()
  }, [refresh])

  React.useEffect(() => {
    if (status === 'ready') onDone()
  }, [status, onDone])

  React.useEffect(() => {
    if (mode === 'bind') void loadOwnedAgents()
  }, [mode, loadOwnedAgents])

  if (status === 'mismatch') {
    return (
      <Shell>
        <h1 className="text-[15px] font-bold text-foreground">本机 Agent 属于其他团队</h1>
        <p className="mt-1 text-[12.5px] text-muted-foreground">
          当前登录团队与本机 daemon 绑定的团队不一致,需要重置后重新初始化。
        </p>
        {error && <ErrorLine error={error} />}
        <Button className="mt-3 h-10 bg-coral text-paper hover:opacity-90" disabled={busy} onClick={() => void forceReset()}>
          {busy ? '重置中…' : '重置并重新初始化'}
        </Button>
      </Shell>
    )
  }

  if (status !== 'needs-onboard') {
    return (
      <div className="flex h-screen items-center justify-center bg-background">
        <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
      </div>
    )
  }

  return (
    <Shell>
      <h1 className="text-[15px] font-bold text-foreground">初始化本机 Agent</h1>
      <p className="mt-1 text-[12.5px] text-muted-foreground">新建一个 agent,或把本机绑定到你已有的 agent。</p>

      <div className="mt-3 flex gap-2">
        <Button size="sm" variant={mode === 'new' ? 'default' : 'outline'} onClick={() => setMode('new')}>新建</Button>
        <Button size="sm" variant={mode === 'bind' ? 'default' : 'outline'} onClick={() => setMode('bind')}>绑定已有</Button>
      </div>

      {mode === 'new' ? (
        <div className="mt-3 flex flex-col gap-3">
          <Input placeholder="Agent 名字" value={name} onChange={(e) => setName(e.target.value)} className="h-10" />
          <div className="flex gap-2">
            <Button size="sm" variant={visibility === 'team' ? 'default' : 'outline'} onClick={() => setVisibility('team')}>团队可见</Button>
            <Button size="sm" variant={visibility === 'personal' ? 'default' : 'outline'} onClick={() => setVisibility('personal')}>仅自己</Button>
          </div>
          {error && <ErrorLine error={error} />}
          <Button
            className="h-10 bg-coral text-paper hover:opacity-90"
            disabled={busy || name.trim().length === 0}
            onClick={() => void createNewAgent(name.trim(), visibility)}
          >
            {busy ? '初始化中…' : '创建并启动'}
          </Button>
        </div>
      ) : (
        <div className="mt-3 flex flex-col gap-2">
          {ownedAgents.length === 0 ? (
            <p className="text-[12.5px] text-faint">没有可绑定的 agent。</p>
          ) : (
            ownedAgents.map((a) => (
              <button
                key={a.agentId}
                disabled={busy}
                onClick={() => void bindExistingAgent(a.agentId, a.displayName)}
                className="flex items-center justify-between rounded-[16px] border border-border bg-paper p-4 text-left hover:bg-selected disabled:opacity-50"
              >
                <span className="text-[13px] font-semibold text-foreground">{a.displayName || a.agentId}</span>
                <span className="font-mono text-[11px] text-faint">{a.visibility}</span>
              </button>
            ))
          )}
          {error && <ErrorLine error={error} />}
        </div>
      )}
    </Shell>
  )
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex h-screen flex-col bg-background" data-tauri-drag-region>
      <div className="h-10 shrink-0" data-tauri-drag-region />
      <div className="mx-auto flex w-full max-w-[460px] flex-1 flex-col justify-center px-6 pb-12">{children}</div>
    </div>
  )
}

function ErrorLine({ error }: { error: string }) {
  return (
    <p className="flex items-center gap-1 text-[11.5px] text-coral">
      <AlertCircle className="h-3 w-3" /> {error}
    </p>
  )
}
```

- [ ] **Step 2: typecheck**

Run: `pnpm --filter @teamclaw/app typecheck 2>&1 | tail -10`
Expected: 无 DaemonOnboardingWizard 相关错误。(若 `Button` 无 `variant="outline"` 或 lucide 图标名不符,`grep -n "variant" packages/app/src/components/ui/button.tsx` / `grep -rn "from 'lucide-react'" packages/app/src | head` 对照修正。)

- [ ] **Step 3: 提交**

```bash
git add packages/app/src/components/auth/DaemonOnboardingWizard.tsx
git commit -m "feat(app): DaemonOnboardingWizard UI"
```

---

### Task 6: AuthGate 接入 daemon-onboarding gate

**Files:**
- Modify: `packages/app/src/components/auth/AuthGate.tsx`

- [ ] **Step 1: 读现状**

Run: `sed -n '1,40p' packages/app/src/components/auth/AuthGate.tsx && sed -n '110,165p' packages/app/src/components/auth/AuthGate.tsx`
确认:React import 风格、`isTauri`、`bootstrap !== "ready"` 分支(约 157)、以及末尾 `return <>{children}</>`(约 159)。

- [ ] **Step 2: 加 import + hooks**

在 `AuthGate.tsx` 顶部 import 区加:

```tsx
import { DaemonOnboardingWizard } from '@/components/auth/DaemonOnboardingWizard'
import { useDaemonOnboardingStore } from '@/stores/daemon-onboarding'
```

在组件内(与其它 hooks 并列、return 之前)加:

```tsx
  const daemonStatus = useDaemonOnboardingStore((s) => s.status)
  const daemonLoaded = useDaemonOnboardingStore((s) => s.loaded)
  const refreshDaemonOnboarding = useDaemonOnboardingStore((s) => s.refresh)
  const [daemonOnboardingAck, setDaemonOnboardingAck] = React.useState(false)

  React.useEffect(() => {
    if (isTauri() && session && bootstrap === "ready") void refreshDaemonOnboarding()
  }, [session, bootstrap, refreshDaemonOnboarding])
```

> `session`/`bootstrap` 是该文件已有的变量(bootstrap-ready 分支用到);若命名不同,用文件里实际的名字。React hooks 用文件现有的导入风格(`React.useState` 或具名 `useState`)。

- [ ] **Step 3: 插 gate**

在 `if (isTauri() && bootstrap !== "ready") { ... }` 分支**之后**、`return <>{children}</>` **之前**插入:

```tsx
  // Daemon team onboarding: after login + workspace bootstrap, ensure the local
  // daemon is bound to the current team (new agent / bind existing / force-reset).
  if (isTauri() && !daemonOnboardingAck) {
    if (!daemonLoaded) {
      return <div className="flex h-screen items-center justify-center bg-background" />
    }
    if (daemonStatus === 'needs-onboard' || daemonStatus === 'mismatch') {
      return <DaemonOnboardingWizard onDone={() => setDaemonOnboardingAck(true)} />
    }
  }
```

> `status === 'ready'` 时不渲染向导直接放行;`'unknown'`(current team 还没 load,理论上 bootstrap-ready 后不会发生)也放行避免误拦。`daemonOnboardingAck` 让用户完成后本会话不再拦。

- [ ] **Step 4: typecheck + 单测**

Run: `pnpm --filter @teamclaw/app typecheck 2>&1 | tail -10` → 无错误。
Run: `pnpm --filter @teamclaw/app exec vitest run src/stores/__tests__/daemon-onboarding.test.ts src/components/auth/__tests__/AuthGate.test.tsx 2>&1 | tail -8` → 全绿。
> 若 `AuthGate.test.tsx` 因新 store 渲染路径失败,仿 block① 给它的 setup-store mock 方式,给 `@/stores/daemon-onboarding` 加 mock(返回 `status:'ready'`/`loaded:true`)+ mock `../DaemonOnboardingWizard`,让既有用例直通。

- [ ] **Step 5: 提交**

```bash
git add packages/app/src/components/auth/AuthGate.tsx packages/app/src/components/auth/__tests__/AuthGate.test.tsx
git commit -m "feat(app): gate daemon team onboarding in AuthGate"
```

---

### Task 7: 整链路手测 + 收尾

**Files:** 无新增(验证)。

- [ ] **Step 1: 准备**

```bash
cd /Volumes/openbeta/workspace/teamclaw-v2/.worktrees/unified-install-onboarding
node -e "require('./scripts/ensure-amuxd-sidecar').ensureAmuxdSidecar(process.env)"   # amuxd sidecar 在位
ls ~/.amuxd/bin/amuxd 2>/dev/null || echo "amuxd 未安装(首启向导 block① 会装)"
```

- [ ] **Step 2: 模拟未 onboard**

```bash
~/.amuxd/bin/amuxd clear --force 2>/dev/null || true   # 或删 ~/.amuxd/daemon.toml
```

- [ ] **Step 3: 跑桌面 dev 验证**

Run: `pnpm tauri:dev`
预期:登录(已属某 team)后,bootstrap-ready 之后弹 DaemonOnboardingWizard。
- "新建":输入名字、选可见性、点"创建并启动" → 后台 createTeamInvite → amuxd init → install-service → `get_daemon_team_id` 现返回当前 team → 向导消失进 app。`launchctl list | grep amuxd`(mac)有服务。选 personal 的话 agent visibility 在 Actors 里为 personal。
- "绑定已有":若该 team 下有你 owner 的 agent,列出可选,点击后同样 init+service。
- **mismatch**:把 `~/.amuxd/daemon.toml` 的 team_id 改成别的 → 重启 app → 向导显示"属于其他团队" → 点重置 → `amuxd clear` → 回到新建/绑定。
> 真实 amuxd init 会 POST 生产 `/v1/invites/claim`;需 FC 在线 + 该 team 的 invite 有效。若仅本地无 FC,记录"链路接通、发起到 init 调用"即可,标注 init 远端依赖。

- [ ] **Step 4: 自动化校验**

```bash
cargo test -p teamclaw --lib daemon_onboarding::tests 2>&1 | tail -5
pnpm --filter @teamclaw/app exec vitest run src/stores/__tests__/daemon-onboarding.test.ts 2>&1 | tail -5
pnpm --filter @teamclaw/app typecheck 2>&1 | tail -5
cargo clippy --manifest-path apps/desktop/Cargo.toml -- -D warnings 2>&1 | grep -i "daemon_onboarding" || echo "no daemon_onboarding clippy issues"
```
Expected: Rust 2 pass、前端 4 pass、typecheck 干净、clippy 无 daemon_onboarding 警告。

- [ ] **Step 5: 提交(若手测有小修)**

```bash
git add -A && git commit -m "test(daemon-onboarding): verify login-driven onboarding flow" || echo "nothing to commit"
```

---

## Self-Review

**Spec coverage(对照 design §6.3 状态机):**
- 登录后检测 daemon team_id + 三态(needs-onboard/ready/mismatch) → Task 4 `computeOnboardingStatus` + Task 6 gate ✅
- 新建 agent(名字+可见性)→ Task 4 `createNewAgent`(createTeamInvite → daemon_init → install-service → personal 时 makeAgentPersonal)+ Task 5 UI ✅
- 绑定已有 agent(列 owner 的 agent)→ Task 4 `bindExistingAgent` + `loadOwnedAgents`(listConnectedAgents 按 isOwner 过滤)+ Task 5 列表 ✅
- team_id 不一致强制重置 → Task 4 `forceReset`(daemon_clear)+ Task 5 mismatch 分支 + Task 6 gate ✅
- amuxd init / install-service / clear 的 Tauri 通道 → Task 1/2 ✅
- makeAgentPersonal 端点缺口 → Task 3 ✅
- POST /v1/team/link → **不在本块**(范围说明;已由 team-share 流程调用)。

**Placeholder 扫描:** 无 TBD。amuxd init 真实运行依赖 FC/有效 invite(Task 7 标注为远端依赖,非占位)。各步含完整代码/命令。`session`/`bootstrap` 变量名以 AuthGate 实际为准(Task 6 Step 1 读取确认)。

**类型/命名一致:** Rust `DaemonInitResult{actorId,teamId}`(camelCase serde)↔ 前端 `invoke<{actorId,teamId}>('daemon_init')`;命令名 `daemon_init`/`daemon_install_service`/`daemon_clear` 三处(Rust 定义、handler、前端 invoke)一致;`createTeamInvite` 入参用 Block③ 对齐的生产 key(kind/agentKind/targetActorId);`computeOnboardingStatus`/`OnboardingStatus`/`Visibility` 在 store、测试、组件引用一致;`makeAgentPersonal(agentActorId)` 在接口与实现一致。

**风险/前置:** `amuxd init` 远端依赖 FC + 有效 agent invite;`install-service` 在非 onboard 状态启动会因缺身份退出——本流程在 init 成功(写了 backend.toml)后才调,顺序正确;Task 7 GUI 手测在 bg 会话不便,留本地。
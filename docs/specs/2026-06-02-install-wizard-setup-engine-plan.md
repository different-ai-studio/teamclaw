# 安装向导 + Setup Engine (Block ①) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 桌面首启时,检测 git / opencode / amuxd 是否就绪,并通过图形化向导逐步把缺的装好(amuxd = 复制捆绑二进制到 `~/.amuxd/bin/`;opencode = 委托 `amuxd install-opencode`;git = 检测+引导,可跳过),装齐后放行进入登录。

**Architecture:** desktop Rust 侧新增 `commands/setup.rs`(Setup Engine):声明式的"requirement 检测 + 安装 + 流式进度"命令,复用仓库既有的 `app.shell().sidecar("amuxd")` 调用与 `app.emit("…-progress", …)` + 前端 `listen()` 范式(同 `deps.rs`/`stores/deps.ts`)。前端新增 `stores/setup.ts` + `SetupWizard.tsx`,在 `AuthGate` 首启阶段门控:必需项(amuxd/opencode)未就绪则先走向导。amuxd 只"装"不"启动"(服务注册/onboarding 属 Block ④)。

**Tech Stack:** Rust/Tauri 2(tauri-plugin-shell sidecar、Emitter 事件、tokio)、React 19 + Zustand + Tailwind 4(Editorial Calm token)、Vitest。

**依赖:** Block ②(amuxd 已是 `externalBin` sidecar、`amuxd install-opencode` / `amuxd doctor` CLI 已存在)已完成,本计划建立其上。

---

## File Structure

新增:
- `apps/desktop/src/commands/setup.rs` — Setup Engine:`RequirementStatus` 类型、检测/定位纯函数、Tauri 命令 `setup_list_requirements` / `setup_install`,进度事件 `setup-progress`。
- `packages/app/src/stores/setup.ts` — 前端 setup store(invoke + listen 进度),镜像 `stores/deps.ts` 结构。
- `packages/app/src/components/auth/SetupWizard.tsx` — 首启安装向导 UI(Editorial Calm)。
- `packages/app/src/stores/__tests__/setup.test.ts` — store 进度状态机的 vitest 测试。

修改:
- `apps/desktop/src/commands/mod.rs` — 加 `pub mod setup;`。
- `apps/desktop/src/lib.rs` — `invoke_handler!` 列表加 `setup::setup_list_requirements` / `setup::setup_install`。
- `packages/app/src/components/auth/AuthGate.tsx` — 首启门控:Tauri 下必需项未就绪先渲染 `<SetupWizard>`。

不动:`commands/daemon_installer.rs` 三个桩(`install_local_daemon`/`daemon_status`/`uninstall_local_daemon`)留给 Block ④ 的 daemon 服务化/onboarding 重写;本计划只新增 `setup.*`,不碰它们。

> **范围说明**:本计划只覆盖"装二进制 + 首启向导 UI"。amuxd 服务注册(`amuxd install-service`,Block ② 已提供 CLI)与团队 onboarding(`amuxd init`/新建绑定 agent)属 Block ④,本计划不接线。

---

## Part R — Rust Setup Engine

### Task 1: setup.rs 检测纯函数 + RequirementStatus

**Files:**
- Create: `apps/desktop/src/commands/setup.rs`
- Modify: `apps/desktop/src/commands/mod.rs`

- [ ] **Step 1: 写失败测试**

`apps/desktop/src/commands/setup.rs`:

```rust
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn detect_bin_present_and_absent() {
        let dir = tempfile::tempdir().unwrap();
        let home = dir.path();
        // absent initially
        assert!(!bin_present(home, "amuxd", "amuxd.exe"));
        // create ~/.amuxd/bin/amuxd
        let bin = home.join(".amuxd").join("bin");
        std::fs::create_dir_all(&bin).unwrap();
        let name = if cfg!(windows) { "amuxd.exe" } else { "amuxd" };
        std::fs::write(bin.join(name), b"x").unwrap();
        assert!(bin_present(home, "amuxd", "amuxd.exe"));
    }

    #[test]
    fn target_triple_has_dash() {
        assert!(target_triple().contains('-'));
    }
}
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cargo test -p teamclaw-desktop --lib setup::tests 2>&1 | tail -20`
Expected: 编译失败 `cannot find function bin_present`。
(注：desktop crate 名见 `apps/desktop/Cargo.toml` 的 `[package] name`;若不是 `teamclaw-desktop`,用实际包名。可先 `grep '^name' apps/desktop/Cargo.toml` 确认,后续命令同。)

- [ ] **Step 3: 写最小实现**

`apps/desktop/src/commands/setup.rs` 顶部:

```rust
use serde::Serialize;
use std::path::{Path, PathBuf};

/// One installable/checkable prerequisite shown in the first-run wizard.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RequirementStatus {
    pub id: String,
    pub title: String,
    pub optional: bool,
    pub present: bool,
    pub version: Option<String>,
}

/// True if `~/.amuxd/bin/<name>` (or the .exe variant on Windows) exists under `home`.
fn bin_present(home: &Path, name_unix: &str, name_win: &str) -> bool {
    let name = if cfg!(windows) { name_win } else { name_unix };
    home.join(".amuxd").join("bin").join(name).exists()
}

/// Rust target triple for the current host (matches the sidecar naming convention).
fn target_triple() -> String {
    let arch = std::env::consts::ARCH;
    match std::env::consts::OS {
        "macos" => format!("{arch}-apple-darwin"),
        "linux" => format!("{arch}-unknown-linux-gnu"),
        "windows" => format!("{arch}-pc-windows-msvc"),
        other => format!("{arch}-unknown-{other}"),
    }
}

/// `git --version` first line, or None if git is unavailable.
fn detect_git() -> Option<String> {
    let out = std::process::Command::new("git")
        .args(["--version"])
        .output()
        .ok()?;
    if !out.status.success() {
        return None;
    }
    Some(String::from_utf8_lossy(&out.stdout).trim().to_string())
}
```

Add `pub mod setup;` to `apps/desktop/src/commands/mod.rs` (keep the alphabetical-ish ordering — place after `pub mod serve;`/before `pub mod show...` or wherever `s*` modules sit; if unsure, add it next to `pub mod deps;`).

- [ ] **Step 4: 运行测试确认通过**

Run: `cargo test -p teamclaw-desktop --lib setup::tests 2>&1 | tail -20`
Expected: 2 passed.
(若报 `tempfile` 不可用:`grep tempfile apps/desktop/Cargo.toml`;不存在则在 `[dev-dependencies]` 加 `tempfile = "3"`。)

- [ ] **Step 5: 提交**

```bash
cd /Volumes/openbeta/workspace/teamclaw-v2/.worktrees/unified-install-onboarding
git branch --show-current   # must be agent/unified-install-onboarding
git add apps/desktop/src/commands/setup.rs apps/desktop/src/commands/mod.rs apps/desktop/Cargo.toml
git commit -m "feat(desktop): setup engine detection helpers"
```

---

### Task 2: bundled amuxd 定位 + setup_list_requirements 命令

**Files:**
- Modify: `apps/desktop/src/commands/setup.rs`
- Modify: `apps/desktop/src/lib.rs`

- [ ] **Step 1: 写失败测试(定位器的纯内核)**

追加到 `mod tests`:

```rust
    #[test]
    fn resolve_exe_finds_plain_and_missing() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("amuxd-some-triple");
        assert!(resolve_exe(p.clone()).is_none());
        std::fs::write(&p, b"x").unwrap();
        assert_eq!(resolve_exe(p.clone()), Some(p));
    }
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cargo test -p teamclaw-desktop --lib setup::tests::resolve_exe_finds_plain_and_missing 2>&1 | tail -20`
Expected: `cannot find function resolve_exe`.

- [ ] **Step 3: 写实现**

追加到 `setup.rs`:

```rust
/// Resolve an executable path, trying a `.exe` suffix on Windows. Mirrors opencode.rs.
fn resolve_exe(path: PathBuf) -> Option<PathBuf> {
    if path.exists() {
        return Some(path);
    }
    if cfg!(windows) {
        let mut with_exe = path.into_os_string();
        with_exe.push(".exe");
        let with_exe = PathBuf::from(with_exe);
        if with_exe.exists() {
            return Some(with_exe);
        }
    }
    None
}

/// Locate the amuxd binary bundled with the app (dev: apps/desktop/binaries; prod: next to exe).
fn locate_bundled_amuxd() -> Option<PathBuf> {
    let triple = target_triple();
    let dev = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("binaries")
        .join(format!("amuxd-{triple}"));
    if let Some(p) = resolve_exe(dev) {
        return Some(p);
    }
    let exe = std::env::current_exe().ok()?;
    let dir = exe.parent()?;
    for cand in [format!("amuxd-{triple}"), "amuxd".to_string()] {
        if let Some(p) = resolve_exe(dir.join(cand)) {
            return Some(p);
        }
    }
    None
}
```

Then the list command (uses tauri path API for home):

```rust
use tauri::{AppHandle, Manager, Runtime};

#[tauri::command]
pub async fn setup_list_requirements<R: Runtime>(
    app: AppHandle<R>,
) -> Result<Vec<RequirementStatus>, String> {
    let home = app.path().home_dir().map_err(|e| e.to_string())?;

    let git_version = detect_git();
    let amuxd_present = bin_present(&home, "amuxd", "amuxd.exe");
    let opencode_present = bin_present(&home, "opencode", "opencode.exe");

    Ok(vec![
        RequirementStatus {
            id: "amuxd".into(),
            title: "Agent daemon (amuxd)".into(),
            optional: false,
            present: amuxd_present,
            version: None,
        },
        RequirementStatus {
            id: "opencode".into(),
            title: "OpenCode runtime".into(),
            optional: false,
            present: opencode_present,
            version: None,
        },
        RequirementStatus {
            id: "git".into(),
            title: "Git".into(),
            optional: true,
            present: git_version.is_some(),
            version: git_version,
        },
    ])
}
```

Register in `apps/desktop/src/lib.rs` `invoke_handler!` list (next to the `daemon_*` entries around line 366):

```rust
            commands::setup::setup_list_requirements,
            commands::setup::setup_install,
```

(`setup_install` is created in Task 4 — adding both lines now is fine because the module won't compile until Task 4 defines it; if you want intermediate compilation, add only `setup_list_requirements` here in Task 2 and add `setup_install` in Task 4.)

- [ ] **Step 4: 运行测试 + 编译**

Run: `cargo test -p teamclaw-desktop --lib setup::tests 2>&1 | tail -20`
Expected: 3 passed.
(若此时 `setup_install` 尚未定义导致 lib 不编译,先只在 handler 加 `setup_list_requirements` 一行。)

- [ ] **Step 5: 提交**

```bash
git add apps/desktop/src/commands/setup.rs apps/desktop/src/lib.rs
git commit -m "feat(desktop): locate bundled amuxd + setup_list_requirements"
```

---

### Task 3: setup_install — amuxd 复制 + opencode 流式 + git 引导

**Files:**
- Modify: `apps/desktop/src/commands/setup.rs`

> 安装动作有文件/进程副作用,采用集成式手测;定位/检测纯函数已被 Task 1-2 覆盖。进度事件用 `app.emit`,前端 `listen`(Task 5-6)。

- [ ] **Step 1: 写进度类型 + 安装实现**

追加到 `setup.rs`:

```rust
use tauri::Emitter;
use tauri_plugin_shell::process::CommandEvent;
use tauri_plugin_shell::ShellExt;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SetupProgress {
    pub id: String,
    /// "started" | "running" | "done" | "failed"
    pub status: String,
    pub line: Option<String>,
    pub error: Option<String>,
}

fn emit_progress<R: Runtime>(app: &AppHandle<R>, p: SetupProgress) {
    let _ = app.emit("setup-progress", p);
}

/// Copy the bundled amuxd binary into ~/.amuxd/bin/amuxd (install only — no service/start).
fn install_amuxd<R: Runtime>(app: &AppHandle<R>) -> Result<(), String> {
    emit_progress(app, SetupProgress { id: "amuxd".into(), status: "started".into(), line: None, error: None });
    let src = locate_bundled_amuxd().ok_or_else(|| "bundled amuxd binary not found".to_string())?;
    let home = app.path().home_dir().map_err(|e| e.to_string())?;
    let bin_dir = home.join(".amuxd").join("bin");
    std::fs::create_dir_all(&bin_dir).map_err(|e| e.to_string())?;
    let dest = bin_dir.join(if cfg!(windows) { "amuxd.exe" } else { "amuxd" });
    std::fs::copy(&src, &dest).map_err(|e| format!("copy amuxd failed: {e}"))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mut perms = std::fs::metadata(&dest).map_err(|e| e.to_string())?.permissions();
        perms.set_mode(0o755);
        std::fs::set_permissions(&dest, perms).map_err(|e| e.to_string())?;
    }
    emit_progress(app, SetupProgress { id: "amuxd".into(), status: "done".into(), line: None, error: None });
    Ok(())
}

/// Run the bundled `amuxd install-opencode` sidecar, streaming its JSON progress lines.
async fn install_opencode<R: Runtime>(app: &AppHandle<R>) -> Result<(), String> {
    emit_progress(app, SetupProgress { id: "opencode".into(), status: "started".into(), line: None, error: None });
    let (mut rx, _child) = app
        .shell()
        .sidecar("amuxd")
        .map_err(|e| format!("sidecar amuxd: {e}"))?
        .args(["install-opencode"])
        .spawn()
        .map_err(|e| format!("spawn amuxd: {e}"))?;

    let mut last_err: Option<String> = None;
    while let Some(event) = rx.recv().await {
        match event {
            CommandEvent::Stdout(bytes) => {
                let line = String::from_utf8_lossy(&bytes).trim().to_string();
                if !line.is_empty() {
                    emit_progress(app, SetupProgress { id: "opencode".into(), status: "running".into(), line: Some(line), error: None });
                }
            }
            CommandEvent::Stderr(bytes) => {
                let line = String::from_utf8_lossy(&bytes).trim().to_string();
                if !line.is_empty() {
                    emit_progress(app, SetupProgress { id: "opencode".into(), status: "running".into(), line: Some(line), error: None });
                }
            }
            CommandEvent::Terminated(payload) => {
                if payload.code.unwrap_or(-1) != 0 {
                    last_err = Some(format!("amuxd install-opencode exited with code {:?}", payload.code));
                }
            }
            _ => {}
        }
    }
    if let Some(e) = last_err {
        emit_progress(app, SetupProgress { id: "opencode".into(), status: "failed".into(), line: None, error: Some(e.clone()) });
        return Err(e);
    }
    emit_progress(app, SetupProgress { id: "opencode".into(), status: "done".into(), line: None, error: None });
    Ok(())
}

/// Best-effort git install guidance. macOS triggers the Xcode CLT installer; other
/// platforms return an error so the UI shows manual instructions (git is optional).
fn install_git<R: Runtime>(app: &AppHandle<R>) -> Result<(), String> {
    emit_progress(app, SetupProgress { id: "git".into(), status: "started".into(), line: None, error: None });
    #[cfg(target_os = "macos")]
    {
        let _ = app;
        std::process::Command::new("xcode-select")
            .arg("--install")
            .status()
            .map_err(|e| format!("xcode-select: {e}"))?;
        emit_progress(app, SetupProgress { id: "git".into(), status: "running".into(), line: Some("Follow the macOS installer dialog to install Command Line Tools.".into()), error: None });
        return Ok(());
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = app;
        Err("Please install git from https://git-scm.com/downloads and re-check.".into())
    }
}

#[tauri::command]
pub async fn setup_install<R: Runtime>(app: AppHandle<R>, id: String) -> Result<(), String> {
    match id.as_str() {
        "amuxd" => install_amuxd(&app),
        "opencode" => install_opencode(&app).await,
        "git" => install_git(&app),
        other => Err(format!("unknown requirement: {other}")),
    }
}
```

- [ ] **Step 2: 编译检查**

Run: `cargo check -p teamclaw-desktop 2>&1 | tail -20`
Expected: 无 error。

- [ ] **Step 3: 手测(本机已有 amuxd sidecar)**

确保已构建 amuxd sidecar(`node -e "require('./scripts/ensure-amuxd-sidecar').ensureAmuxdSidecar(process.env)"`),然后用一个临时单测或 `pnpm tauri:dev` 触发(Task 5-7 接前端后整链路验证)。最小验证:`cargo test -p teamclaw-desktop --lib setup::tests` 仍 3 passed,且 `cargo check` 干净。
> 真实链路(amuxd 复制 + opencode 下载)在 Task 7 接好前端后手测;opencode 实际下载需 `opencode.lock.json` 的 version 已填实(见 Block ② 待办)。

- [ ] **Step 4: 提交**

```bash
git add apps/desktop/src/commands/setup.rs
git commit -m "feat(desktop): setup_install (amuxd copy / opencode via amuxd CLI / git guide)"
```

---

## Part F — 前端向导

### Task 4: stores/setup.ts + 进度状态机测试

**Files:**
- Create: `packages/app/src/stores/setup.ts`
- Create: `packages/app/src/stores/__tests__/setup.test.ts`

- [ ] **Step 1: 写失败测试**

`packages/app/src/stores/__tests__/setup.test.ts`:

```ts
import { describe, it, expect, beforeEach } from 'vitest'
import { useSetupStore, applyProgress } from '../setup'

describe('setup store progress reducer', () => {
  beforeEach(() => {
    useSetupStore.setState({
      requirements: [
        { id: 'amuxd', title: 'amuxd', optional: false, present: false, version: null },
        { id: 'opencode', title: 'opencode', optional: false, present: false, version: null },
        { id: 'git', title: 'git', optional: true, present: false, version: null },
      ],
      installing: null,
      output: {},
      errors: {},
    })
  })

  it('records running output lines', () => {
    applyProgress({ id: 'opencode', status: 'running', line: 'downloading', error: null })
    expect(useSetupStore.getState().output['opencode']).toContain('downloading')
  })

  it('marks present on done', () => {
    applyProgress({ id: 'amuxd', status: 'done', line: null, error: null })
    const req = useSetupStore.getState().requirements.find((r) => r.id === 'amuxd')!
    expect(req.present).toBe(true)
  })

  it('records error on failed', () => {
    applyProgress({ id: 'opencode', status: 'failed', line: null, error: 'boom' })
    expect(useSetupStore.getState().errors['opencode']).toBe('boom')
  })

  it('requiredSatisfied is true only when all non-optional are present', () => {
    expect(useSetupStore.getState().requiredSatisfied()).toBe(false)
    applyProgress({ id: 'amuxd', status: 'done', line: null, error: null })
    applyProgress({ id: 'opencode', status: 'done', line: null, error: null })
    expect(useSetupStore.getState().requiredSatisfied()).toBe(true) // git optional, still absent
  })
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm --filter @teamclaw/app test:unit -- src/stores/__tests__/setup.test.ts 2>&1 | tail -20`
Expected: 失败 `Cannot find module '../setup'`.
(若该过滤参数语法不被接受,用 `pnpm test:unit` 跑全量也可;或 `grep '"test:unit"' package.json` 看实际脚本。)

- [ ] **Step 3: 写实现**

`packages/app/src/stores/setup.ts`:

```ts
import { create } from 'zustand'
import { isTauri } from '@/lib/utils'

export type RequirementStatus = {
  id: string
  title: string
  optional: boolean
  present: boolean
  version: string | null
}

export type SetupProgress = {
  id: string
  status: 'started' | 'running' | 'done' | 'failed'
  line: string | null
  error: string | null
}

type SetupState = {
  requirements: RequirementStatus[]
  installing: string | null
  output: Record<string, string[]>
  errors: Record<string, string>
  loaded: boolean
  listRequirements: () => Promise<void>
  install: (id: string) => Promise<void>
  requiredSatisfied: () => boolean
}

export const useSetupStore = create<SetupState>((set, get) => ({
  requirements: [],
  installing: null,
  output: {},
  errors: {},
  loaded: false,

  requiredSatisfied: () =>
    get().requirements.filter((r) => !r.optional).every((r) => r.present),

  listRequirements: async () => {
    if (!isTauri()) {
      set({ loaded: true })
      return
    }
    const { invoke } = await import('@tauri-apps/api/core')
    const requirements = await invoke<RequirementStatus[]>('setup_list_requirements')
    set({ requirements, loaded: true })
  },

  install: async (id: string) => {
    if (!isTauri()) return
    const { invoke } = await import('@tauri-apps/api/core')
    const { listen } = await import('@tauri-apps/api/event')
    set({ installing: id })
    const unlisten = await listen<SetupProgress>('setup-progress', (event) => {
      applyProgress(event.payload)
    })
    try {
      await invoke('setup_install', { id })
      // refresh authoritative status after install
      const requirements = await invoke<RequirementStatus[]>('setup_list_requirements')
      set({ requirements })
    } catch (e) {
      set((s) => ({ errors: { ...s.errors, [id]: String(e) } }))
    } finally {
      unlisten()
      set({ installing: null })
    }
  },
}))

/** Pure reducer applied to each setup-progress event (exported for tests). */
export function applyProgress(p: SetupProgress) {
  useSetupStore.setState((s) => {
    const output = { ...s.output }
    const errors = { ...s.errors }
    let requirements = s.requirements

    if (p.status === 'running' && p.line) {
      output[p.id] = [...(output[p.id] ?? []), p.line]
    }
    if (p.status === 'failed' && p.error) {
      errors[p.id] = p.error
    }
    if (p.status === 'done') {
      requirements = requirements.map((r) => (r.id === p.id ? { ...r, present: true } : r))
    }
    return { output, errors, requirements }
  })
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `pnpm --filter @teamclaw/app test:unit -- src/stores/__tests__/setup.test.ts 2>&1 | tail -20`
Expected: 4 passed.

- [ ] **Step 5: 提交**

```bash
git add packages/app/src/stores/setup.ts packages/app/src/stores/__tests__/setup.test.ts
git commit -m "feat(app): setup store with progress reducer"
```

---

### Task 5: SetupWizard 组件

**Files:**
- Create: `packages/app/src/components/auth/SetupWizard.tsx`

- [ ] **Step 1: 写组件**

`packages/app/src/components/auth/SetupWizard.tsx`(沿用 `DesktopOnboarding.tsx` 的容器风格与 token):

```tsx
import * as React from 'react'
import { Check, Loader2, Download, AlertCircle } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useSetupStore, type RequirementStatus } from '@/stores/setup'

function StatusIcon({ req, installing }: { req: RequirementStatus; installing: boolean }) {
  if (req.present) return <Check className="h-4 w-4 text-coral" />
  if (installing) return <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
  return <Download className="h-4 w-4 text-faint" />
}

export function SetupWizard({ onDone }: { onDone: () => void }) {
  const { requirements, installing, output, errors, loaded, listRequirements, install, requiredSatisfied } =
    useSetupStore()

  React.useEffect(() => {
    void listRequirements()
  }, [listRequirements])

  if (!loaded) {
    return (
      <div className="flex h-screen items-center justify-center bg-background">
        <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
      </div>
    )
  }

  return (
    <div className="flex h-screen flex-col bg-background" data-tauri-drag-region>
      <div className="h-10 shrink-0" data-tauri-drag-region />
      <div className="mx-auto flex w-full max-w-[460px] flex-1 flex-col justify-center gap-4 px-6 pb-12">
        <div>
          <h1 className="text-[15px] font-bold text-foreground">准备运行环境</h1>
          <p className="mt-1 text-[12.5px] text-muted-foreground">
            首次启动需要安装本机依赖,稍等片刻即可。
          </p>
        </div>

        <div className="flex flex-col gap-2">
          {requirements.map((req) => {
            const isInstalling = installing === req.id
            const lines = output[req.id] ?? []
            const err = errors[req.id]
            return (
              <div key={req.id} className="rounded-[16px] border border-border bg-paper p-4">
                <div className="flex items-center justify-between gap-3">
                  <div className="flex items-center gap-2">
                    <StatusIcon req={req} installing={isInstalling} />
                    <span className="text-[13px] font-semibold text-foreground">{req.title}</span>
                    {req.optional && (
                      <span className="rounded-[4px] bg-panel px-1.5 py-0.5 text-[11px] text-muted-foreground">
                        可选
                      </span>
                    )}
                  </div>
                  {req.present ? (
                    <span className="font-mono text-[11px] text-faint">已就绪</span>
                  ) : (
                    <Button
                      size="sm"
                      disabled={installing !== null}
                      onClick={() => void install(req.id)}
                    >
                      {isInstalling ? '安装中…' : '安装'}
                    </Button>
                  )}
                </div>
                {req.version && (
                  <p className="mt-1 font-mono text-[11px] text-faint">{req.version}</p>
                )}
                {isInstalling && lines.length > 0 && (
                  <p className="mt-2 truncate font-mono text-[11px] text-muted-foreground">
                    {lines[lines.length - 1]}
                  </p>
                )}
                {err && (
                  <p className="mt-2 flex items-center gap-1 text-[11.5px] text-coral">
                    <AlertCircle className="h-3 w-3" /> {err}
                  </p>
                )}
              </div>
            )
          })}
        </div>

        <Button
          className="mt-2 h-10 bg-coral text-paper hover:opacity-90"
          disabled={!requiredSatisfied() || installing !== null}
          onClick={onDone}
        >
          {requiredSatisfied() ? '继续' : '请先安装必需项'}
        </Button>
      </div>
    </div>
  )
}
```

- [ ] **Step 2: typecheck**

Run: `pnpm --filter @teamclaw/app typecheck 2>&1 | tail -20`
Expected: 无 SetupWizard 相关错误。
(若 lucide 图标名不存在,用 `grep -r "from 'lucide-react'" packages/app/src | head` 参照现有用法替换。)

- [ ] **Step 3: 提交**

```bash
git add packages/app/src/components/auth/SetupWizard.tsx
git commit -m "feat(app): SetupWizard first-run UI"
```

---

### Task 6: AuthGate 首启门控

**Files:**
- Modify: `packages/app/src/components/auth/AuthGate.tsx`

- [ ] **Step 1: 读现状**

Run: `sed -n '1,140p' packages/app/src/components/auth/AuthGate.tsx`
确认:`isTauri` import、`!session` 分支(约 114-116)渲染 `<DesktopOnboarding />` 的位置。

- [ ] **Step 2: 加首启 setup 门控**

在 `AuthGate.tsx` 顶部 import 区加:

```tsx
import { SetupWizard } from '@/components/auth/SetupWizard'
import { useSetupStore } from '@/stores/setup'
```

在组件内(与其它 hooks 并列、return 之前)加:

```tsx
  const setupLoaded = useSetupStore((s) => s.loaded)
  const setupRequiredSatisfied = useSetupStore((s) => s.requiredSatisfied())
  const listSetup = useSetupStore((s) => s.listRequirements)
  const [setupAck, setSetupAck] = React.useState(false)

  React.useEffect(() => {
    if (isTauri()) void listSetup()
  }, [listSetup])
```

在**最前面的 Tauri 分支之前**(即首个 `if (isTauri() ...)` / `if (!session)` 之前)插入门控:

```tsx
  // First-run: in Tauri, ensure local prerequisites (amuxd/opencode) before auth.
  if (isTauri() && !setupAck) {
    if (!setupLoaded) {
      return (
        <div className="flex h-screen items-center justify-center bg-background" />
      )
    }
    if (!setupRequiredSatisfied) {
      return <SetupWizard onDone={() => setSetupAck(true)} />
    }
  }
```

> 说明:`setupAck` 让用户点"继续"后即使本次会话不再拦截;`requiredSatisfied` 基于实时检测(amuxd/opencode 存在即放行),git 可选不阻断。确保 `React` 已在文件内 import(若文件用具名 hooks,改用 `import * as React` 或 `useState`/`useEffect` 具名导入,与文件现有风格一致)。

- [ ] **Step 3: typecheck + 单测**

Run: `pnpm --filter @teamclaw/app typecheck 2>&1 | tail -20` → 无错误。
Run: `pnpm --filter @teamclaw/app test:unit -- src/stores/__tests__/setup.test.ts 2>&1 | tail -5` → 4 passed。

- [ ] **Step 4: 提交**

```bash
git add packages/app/src/components/auth/AuthGate.tsx
git commit -m "feat(app): gate first-run setup wizard in AuthGate"
```

---

### Task 7: 整链路手测 + 收尾

**Files:** 无新增(验证任务)。

- [ ] **Step 1: 准备 sidecar**

```bash
cd /Volumes/openbeta/workspace/teamclaw-v2/.worktrees/unified-install-onboarding
node -e "require('./scripts/ensure-amuxd-sidecar').ensureAmuxdSidecar(process.env)"
ls apps/desktop/binaries/amuxd-*
```
Expected: amuxd sidecar 存在。

- [ ] **Step 2: 模拟"未安装"起点**

```bash
mv ~/.amuxd/bin ~/.amuxd/bin.bak 2>/dev/null || true
```
(若 `~/.amuxd/bin` 不存在则跳过。)

- [ ] **Step 3: 跑桌面 dev,验证向导出现并能装 amuxd**

Run: `pnpm tauri:dev`
预期:首启进入 SetupWizard;amuxd 显示"安装"按钮,点击后变"已就绪"(`~/.amuxd/bin/amuxd` 被创建)。opencode 安装需 `opencode.lock.json` 的 version 填实(Block ② 待办);若仍是占位,opencode 安装会失败并显示错误——这是预期,记录之,不阻塞本任务验收(amuxd 链路通即可)。git 显示已就绪(本机有 git)。
> 验证完成后恢复:`mv ~/.amuxd/bin.bak ~/.amuxd/bin 2>/dev/null || true`(若之前备份过)。

- [ ] **Step 4: 全量校验**

```bash
cargo test -p teamclaw-desktop --lib setup::tests 2>&1 | tail -5
pnpm --filter @teamclaw/app test:unit -- src/stores/__tests__/setup.test.ts 2>&1 | tail -5
pnpm --filter @teamclaw/app typecheck 2>&1 | tail -5
cargo clippy --manifest-path apps/desktop/Cargo.toml -- -D warnings 2>&1 | tail -15
```
Expected: Rust setup 测试通过、前端 setup 测试 4 passed、typecheck 干净、clippy 无新增 setup 相关警告。

- [ ] **Step 5: 提交(若手测中有小修)**

```bash
git add -A && git commit -m "test(setup): verify first-run wizard end-to-end" || echo "nothing to commit"
```

---

## Self-Review

**Spec coverage(对照 design §4 Setup Engine + §3 生命周期"安装向导"段属于 Block ① 的条目):**
- 声明式 requirement 检测(git/opencode/amuxd)→ Task 1-2 `setup_list_requirements` ✅
- amuxd = 复制捆绑二进制到 `~/.amuxd/bin`,只装不启动 → Task 3 `install_amuxd` ✅
- opencode = 委托 `amuxd install-opencode`、流式进度 → Task 3 `install_opencode` + emit `setup-progress` ✅
- git = 检测 + 引导、可跳过(optional) → Task 1 detect + Task 3 `install_git`(mac xcode-select / 其它平台引导) ✅
- 前端首启向导 UI + 门控 + 重入(每次基于实时检测) → Task 4-6 ✅
- 服务注册 / `amuxd init` / 团队 onboarding → **不在本计划**(Block ④);`daemon_installer.rs` 桩保持不动。

**Placeholder 扫描:** 无 TBD/TODO。opencode 真实下载依赖 Block ② 的 `opencode.lock.json` version 填实——已在 Task 3 Step 3 / Task 7 Step 3 显式说明为已知前置,非本计划占位。desktop crate 名以 `apps/desktop/Cargo.toml` 实际 `name` 为准(Task 1 Step 2 给了确认命令)。

**类型一致性:** Rust `RequirementStatus`(camelCase serde:id/title/optional/present/version)与 TS `RequirementStatus` 字段一致;`SetupProgress`(id/status/line/error,camelCase)Rust 与 TS 一致;命令名 `setup_list_requirements` / `setup_install` 在 Rust 定义、handler 注册、前端 invoke 三处一致;事件名 `setup-progress` 在 Rust emit 与前端 listen 一致;`applyProgress` / `requiredSatisfied` 在 store 与测试/组件引用一致。

**已知前置/风险:** opencode 实际安装需 Block ② 的 lock version 落地;`pnpm tauri:dev` 手测较重(Task 7),CI 不跑;git 安装在非 mac 平台仅返回引导文案(符合 optional 设计)。

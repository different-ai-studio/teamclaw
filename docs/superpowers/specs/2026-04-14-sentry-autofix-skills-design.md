# Sentry Auto-Fix Skills Design

Two Claude Code skills for semi-automated Sentry issue monitoring and fixing.

## Context

TeamClaw has Sentry integrated on both Rust backend (`ucar-inc/teamclaw`) and React frontend (`ucar-inc/teamclaw-react`). Currently 10+ unresolved high/fatal issues across both projects with no automated triage or fix workflow.

## Decision

Two independent local skills following existing `fc-deploy`/`fc-logs` pattern:

| Skill | Purpose | Trigger |
|-------|---------|---------|
| `sentry-monitor` | Scan issues, analyze root causes, push report to WeCom | `/sentry-monitor` or `/loop 24h /sentry-monitor` |
| `sentry-fix` | Fix a specific issue, add regression test, create PR | `/sentry-fix <ISSUE-ID>` |

Scope: only fatal/high priority issues. Both Rust and React projects.

---

## Skill 1: sentry-monitor

### Trigger

- Skill name: `sentry-monitor`
- Description triggers: "sentry 监控", "sentry 日报", "查看 sentry", "sentry report"
- Accepts no arguments

### Flow

1. **Scan** — `sentry issue list` for both projects, filter `level=fatal` or `priority=high`, `is:unresolved`
2. **Analyze** — `sentry issue explain <id> --json` for each issue (skip on timeout/failure)
3. **Format report** — Group by project, include issue ID, level, title, root cause summary
4. **Push to WeCom** — Use `wecomcli-get-msg` skill to send report to designated chat

### Report Format

```
Sentry 日报 <date>

【Rust 后端】N 个高优 issue
- TEAMCLAW-X [fatal] <title> — 根因：<summary>
- ...

【React 前端】N 个高优 issue
- TEAMCLAW-REACT-XX [high] <title> — 根因：<summary>
- ...

修复命令：/sentry-fix <ISSUE-ID>
```

If no fatal/high issues exist, send "Sentry 全部正常" instead.

### Constraints

- Read-only, no code changes
- Each `explain` call has implicit timeout from Seer AI; if analysis unavailable, mark as "分析中"
- Does not deduplicate across runs (each run reports current state)

---

## Skill 2: sentry-fix

### Trigger

- Skill name: `sentry-fix`
- Description triggers: "修复 sentry", "fix sentry issue", "sentry 修复"
- Accepts one required argument: Sentry issue short ID (e.g., `TEAMCLAW-3`, `TEAMCLAW-REACT-2G`)

### Flow

#### Phase 1: Gather Context

1. `sentry issue view <id> --json` — full issue details
2. `sentry issue explain <id> --json` — root cause analysis
3. `sentry issue plan <id> --json` — Sentry's suggested fix plan
4. Read source files mentioned in the analysis

#### Phase 2: Confirm with User

5. Present fix plan in terminal:
   - Root cause summary
   - Files to modify
   - Proposed changes
   - Test plan
6. Wait for user confirmation before proceeding

#### Phase 3: Implement Fix

7. Create branch: `sentry-fix/<issue-id>` (e.g., `sentry-fix/TEAMCLAW-3`)
8. Implement the fix following existing code patterns
9. Write regression test:
   - Rust issues: `#[test]` in the relevant module
   - React issues: vitest test in corresponding `__tests__` or `.test.ts` file
   - Test must reproduce the original failure scenario

#### Phase 4: Verify

10. Run verification suite:
    - Frontend: `pnpm test:unit && pnpm typecheck && pnpm lint`
    - Backend: `cargo clippy --manifest-path src-tauri/Cargo.toml -- -D warnings`
11. If verification fails: auto-fix and retry (max 2 rounds)
12. If still failing after retries: stop and report to user

#### Phase 5: Submit

13. Commit with message: `fix(<scope>): <description> (Sentry <ISSUE-ID>)`
14. Push branch: `git push -u origin sentry-fix/<issue-id>`
15. Create PR via `gh pr create`:
    - Title: `fix(<scope>): <description>`
    - Body includes: Sentry issue link, root cause, fix description, test coverage

### Constraints

- User must confirm fix plan before any code changes
- If `explain` returns empty or low-confidence results, prompt user for additional context
- Only modify files related to the issue
- Follow existing code style (no gratuitous refactoring)
- Branch naming: `sentry-fix/<issue-id>` (lowercase)

---

## File Structure

```
.claude/skills/
  sentry-monitor/
    SKILL.md          # Skill definition
  sentry-fix/
    SKILL.md          # Skill definition
```

No shell scripts needed — both skills are pure Claude Code instruction files that orchestrate CLI tools (`sentry`, `gh`, `git`) and other skills (`wecomcli-get-msg`).

---

## Dependencies

- `sentry` CLI: installed and authenticated (verified working)
- `gh` CLI: for PR creation
- `wecomcli-get-msg` skill: for WeCom message delivery
- Sentry projects: `ucar-inc/teamclaw` (Rust), `ucar-inc/teamclaw-react` (React)

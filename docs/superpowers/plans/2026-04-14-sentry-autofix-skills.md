# Sentry Auto-Fix Skills Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Create two Claude Code skills — `sentry-monitor` (daily Sentry issue scan + WeCom report) and `sentry-fix` (one-click issue fix + test + PR).

**Architecture:** Two independent SKILL.md files under `.claude/skills/`, no shell scripts. Each skill is a Claude Code instruction document that orchestrates `sentry` CLI, `git`, `gh`, and the existing `wecomcli-get-msg` skill.

**Tech Stack:** Sentry CLI, GitHub CLI (`gh`), Git, WeCom CLI (existing skill)

---

### Task 1: Create sentry-monitor skill

**Files:**
- Create: `.claude/skills/sentry-monitor/SKILL.md`

- [ ] **Step 1: Create the skill directory**

```bash
mkdir -p .claude/skills/sentry-monitor
```

- [ ] **Step 2: Write the SKILL.md file**

Create `.claude/skills/sentry-monitor/SKILL.md` with this exact content:

```markdown
---
name: sentry-monitor
description: Use when the user wants to check Sentry issues, run a Sentry daily report, or monitor error trends. Triggers on "sentry 监控", "sentry 日报", "查看 sentry", "sentry report", "sentry monitor".
---

# Sentry Monitor — Daily Issue Report

Scan both TeamClaw Sentry projects for unresolved fatal/high issues, analyze root causes, and push a summary report to WeCom.

## Projects

| Project | Sentry Slug | Platform |
|---------|-------------|----------|
| Rust backend | `ucar-inc/teamclaw` | Rust |
| React frontend | `ucar-inc/teamclaw-react` | JavaScript React |

## Execution Steps

### 1. Scan Issues

Run these two commands in parallel:

\`\`\`bash
sentry issue list ucar-inc/teamclaw --query "is:unresolved" --json --fields shortId,title,priority,level,status --limit 20
\`\`\`

\`\`\`bash
sentry issue list ucar-inc/teamclaw-react --query "is:unresolved" --json --fields shortId,title,priority,level,status --limit 20
\`\`\`

Filter results: keep only issues where `level` is `fatal` OR `priority` is `high`.

If no issues match, skip to step 4 with "全部正常" message.

### 2. Analyze Root Causes

For each filtered issue (max 10 total to avoid timeout), run:

\`\`\`bash
sentry issue explain <shortId> --json
\`\`\`

Extract the root cause summary from the response. If the explain call fails or returns no analysis, mark the issue as "分析中".

Run explain calls in parallel where possible (use Agent tool with parallel subagents).

### 3. Format Report

Build a report in this exact format:

\`\`\`
Sentry 日报 <YYYY-MM-DD>

【Rust 后端】N 个高优 issue
• <shortId> [<level>] <title> — 根因：<root cause summary>
• ...

【React 前端】N 个高优 issue
• <shortId> [<level>] <title> — 根因：<root cause summary>
• ...

修复命令：/sentry-fix <top-issue-id>
\`\`\`

If a project has zero matching issues, omit that section entirely.

### 4. Push to WeCom

Use the `wecomcli-get-msg` skill to send the formatted report as a text message.

If no fatal/high issues exist across both projects, send:

\`\`\`
Sentry 日报 <YYYY-MM-DD> — 全部正常，无高优 issue
\`\`\`

## Usage

- One-time: `/sentry-monitor`
- Recurring: `/loop 24h /sentry-monitor`

## Constraints

- This skill is READ-ONLY. Never modify any code files.
- Do not attempt to fix issues. Only report them.
- If `sentry` CLI is not authenticated, prompt the user to run `sentry auth login`.
```

- [ ] **Step 3: Verify the skill file exists and is well-formed**

```bash
cat .claude/skills/sentry-monitor/SKILL.md
```

Expected: the file starts with `---` frontmatter containing `name: sentry-monitor`.

- [ ] **Step 4: Commit**

```bash
git add -f .claude/skills/sentry-monitor/SKILL.md
git commit -m "feat: add sentry-monitor skill for daily issue reporting"
```

---

### Task 2: Create sentry-fix skill

**Files:**
- Create: `.claude/skills/sentry-fix/SKILL.md`

- [ ] **Step 1: Create the skill directory**

```bash
mkdir -p .claude/skills/sentry-fix
```

- [ ] **Step 2: Write the SKILL.md file**

Create `.claude/skills/sentry-fix/SKILL.md` with this exact content:

```markdown
---
name: sentry-fix
description: Use when the user wants to fix a Sentry issue, auto-repair a bug from Sentry, or create a fix PR for a Sentry error. Triggers on "修复 sentry", "fix sentry issue", "sentry 修复", "sentry fix".
---

# Sentry Fix — Auto-Fix Issue with Test and PR

Fix a specific Sentry issue: gather context, confirm with user, implement fix, write regression test, verify, and create PR.

## Arguments

- `<ISSUE-ID>` (required): Sentry issue short ID, e.g., `TEAMCLAW-3` or `TEAMCLAW-REACT-2G`

The issue ID is passed as the skill argument. Example: `/sentry-fix TEAMCLAW-3`

## Projects

| Project | Sentry Slug | Platform | Test Command | Lint Command |
|---------|-------------|----------|--------------|--------------|
| Rust backend | `ucar-inc/teamclaw` | Rust | `cargo test --manifest-path src-tauri/Cargo.toml` | `cargo clippy --manifest-path src-tauri/Cargo.toml -- -D warnings` |
| React frontend | `ucar-inc/teamclaw-react` | React | `pnpm test:unit` | `pnpm typecheck && pnpm lint` |

Determine which project based on the issue ID prefix:
- `TEAMCLAW-<suffix>` (no "REACT") → Rust backend
- `TEAMCLAW-REACT-<suffix>` → React frontend

## Execution Steps

### Phase 1: Gather Context

Run these three commands in parallel:

\`\`\`bash
sentry issue view <ISSUE-ID> --json
\`\`\`

\`\`\`bash
sentry issue explain <ISSUE-ID> --json
\`\`\`

\`\`\`bash
sentry issue plan <ISSUE-ID> --json
\`\`\`

Then read the source files mentioned in the explain/plan output to understand the surrounding code context.

**If explain returns empty or low-confidence results:** Stop and ask the user for additional context about the issue before proceeding. Do NOT guess.

### Phase 2: Confirm with User

Present a fix plan to the user in the terminal. The plan MUST include:

1. **Root cause** — one-paragraph summary from explain
2. **Files to modify** — exact file paths and what changes in each
3. **Proposed fix** — description of the code changes
4. **Regression test plan** — what test will be added and what it verifies
5. **Verification commands** — which commands will be run to validate

**STOP HERE and wait for user confirmation.** Do NOT proceed until the user says yes.

### Phase 3: Implement Fix

1. Create a new branch from current HEAD:

\`\`\`bash
git checkout -b sentry-fix/<issue-id-lowercase>
\`\`\`

Example: `sentry-fix/teamclaw-3` or `sentry-fix/teamclaw-react-2g`

2. Implement the fix:
   - Follow existing code patterns and style
   - Only modify files directly related to the issue
   - No gratuitous refactoring

3. Write a regression test:
   - **Rust issues:** Add `#[test]` in the relevant module's test section, or create a test file in the same directory. The test must reproduce the scenario that caused the original error.
   - **React issues:** Add a vitest test in the corresponding `.test.ts` or `.test.tsx` file (create one if none exists, following existing test file patterns in the codebase). The test must verify the fix prevents the original error.

### Phase 4: Verify

Run the verification suite for the relevant platform:

**Rust backend:**
\`\`\`bash
cargo clippy --manifest-path src-tauri/Cargo.toml -- -D warnings
\`\`\`

**React frontend:**
\`\`\`bash
pnpm test:unit && pnpm typecheck && pnpm lint
\`\`\`

If verification fails:
1. Read the error output
2. Fix the issue
3. Re-run verification
4. Maximum 2 retry rounds. If still failing after 2 retries, stop and report the failure to the user.

### Phase 5: Submit

1. Stage and commit:

\`\`\`bash
git add <changed-files>
git commit -m "fix(<scope>): <description> (Sentry <ISSUE-ID>)"
\`\`\`

Where `<scope>` is the module/component name (e.g., `rag`, `p2p`, `settings`, `editor`).

2. Push the branch:

\`\`\`bash
git push -u origin sentry-fix/<issue-id-lowercase>
\`\`\`

3. Create the PR:

\`\`\`bash
gh pr create --title "fix(<scope>): <short description>" --body "$(cat <<'PREOF'
## Sentry Issue

Fixes [<ISSUE-ID>](<sentry-issue-permalink>)

## Root Cause

<root cause summary from explain>

## Fix

<description of code changes>

## Test Coverage

<description of regression test added>

## Verification

- [ ] cargo clippy / pnpm lint passes
- [ ] Tests pass including new regression test
PREOF
)"
\`\`\`

4. Print the PR URL for the user.

## Constraints

- NEVER modify code before user confirms the fix plan (Phase 2)
- NEVER modify files unrelated to the issue
- ALWAYS write a regression test — no exceptions
- If `sentry` CLI is not authenticated, prompt the user to run `sentry auth login`
- If `gh` CLI is not authenticated, prompt the user to run `gh auth login`
```

- [ ] **Step 3: Verify the skill file exists and is well-formed**

```bash
cat .claude/skills/sentry-fix/SKILL.md
```

Expected: the file starts with `---` frontmatter containing `name: sentry-fix`.

- [ ] **Step 4: Commit**

```bash
git add -f .claude/skills/sentry-fix/SKILL.md
git commit -m "feat: add sentry-fix skill for auto-fixing Sentry issues with test and PR"
```

---

### Task 3: Smoke Test sentry-monitor

**Files:**
- None (verification only)

- [ ] **Step 1: Run the sentry-monitor skill**

```bash
# In Claude Code, run:
/sentry-monitor
```

- [ ] **Step 2: Verify the scan step works**

Check that the skill correctly:
1. Runs `sentry issue list` for both projects
2. Filters to fatal/high only
3. Runs `sentry issue explain` for filtered issues
4. Formats the report correctly

- [ ] **Step 3: Verify WeCom delivery**

Check that the report is sent via `wecomcli-get-msg` skill. Confirm the message appears in the target WeCom chat.

- [ ] **Step 4: Test empty case**

If all issues are resolved, verify the skill sends the "全部正常" message instead.

---

### Task 4: Smoke Test sentry-fix

**Files:**
- None (verification only)

- [ ] **Step 1: Run the sentry-fix skill on a real issue**

Pick a known issue with clear root cause:

```bash
# In Claude Code, run:
/sentry-fix TEAMCLAW-2
```

(TEAMCLAW-2 is "RAG HTTP port already in use" — straightforward to fix)

- [ ] **Step 2: Verify Phase 1 (context gathering)**

Check that the skill:
1. Fetches issue view, explain, and plan in parallel
2. Reads relevant source files
3. Presents a clear fix plan

- [ ] **Step 3: Verify Phase 2 (user confirmation gate)**

Confirm the skill STOPS and waits for user input before modifying any code.

- [ ] **Step 4: Verify Phase 3-5 (fix, test, PR)**

After confirming, check that:
1. A `sentry-fix/teamclaw-2` branch is created
2. The fix is implemented
3. A regression test is added
4. Verification passes
5. A PR is created with the correct format

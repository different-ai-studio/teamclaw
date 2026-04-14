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

```bash
sentry issue view <ISSUE-ID> --json
```

```bash
sentry issue explain <ISSUE-ID> --json
```

```bash
sentry issue plan <ISSUE-ID> --json
```

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

```bash
git checkout -b sentry-fix/<issue-id-lowercase>
```

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
```bash
cargo clippy --manifest-path src-tauri/Cargo.toml -- -D warnings
```

**React frontend:**
```bash
pnpm test:unit && pnpm typecheck && pnpm lint
```

If verification fails:
1. Read the error output
2. Fix the issue
3. Re-run verification
4. Maximum 2 retry rounds. If still failing after 2 retries, stop and report the failure to the user.

### Phase 5: Submit

1. Stage and commit:

```bash
git add <changed-files>
git commit -m "fix(<scope>): <description> (Sentry <ISSUE-ID>)"
```

Where `<scope>` is the module/component name (e.g., `rag`, `p2p`, `settings`, `editor`).

2. Push the branch:

```bash
git push -u origin sentry-fix/<issue-id-lowercase>
```

3. Create the PR:

```bash
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
```

4. Print the PR URL for the user.

## Constraints

- NEVER modify code before user confirms the fix plan (Phase 2)
- NEVER modify files unrelated to the issue
- ALWAYS write a regression test — no exceptions
- If `sentry` CLI is not authenticated, prompt the user to run `sentry auth login`
- If `gh` CLI is not authenticated, prompt the user to run `gh auth login`

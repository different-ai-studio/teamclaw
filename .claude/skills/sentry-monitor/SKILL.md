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

```bash
sentry issue list ucar-inc/teamclaw --query "is:unresolved" --json --fields shortId,title,priority,level,status --limit 20
```

```bash
sentry issue list ucar-inc/teamclaw-react --query "is:unresolved" --json --fields shortId,title,priority,level,status --limit 20
```

Filter results: keep only issues where `level` is `fatal` OR `priority` is `high`.

If no issues match, skip to step 4 with "全部正常" message.

### 2. Analyze Root Causes

For each filtered issue (max 10 total to avoid timeout), run:

```bash
sentry issue explain <shortId> --json
```

Extract the root cause summary from the response. If the explain call fails or returns no analysis, mark the issue as "分析中".

Run explain calls in parallel where possible (use Agent tool with parallel subagents).

### 3. Format Report

Build a report in this exact format:

```
Sentry 日报 <YYYY-MM-DD>

【Rust 后端】N 个高优 issue
• <shortId> [<level>] <title> — 根因：<root cause summary>
• ...

【React 前端】N 个高优 issue
• <shortId> [<level>] <title> — 根因：<root cause summary>
• ...

修复命令：/sentry-fix <top-issue-id>
```

If a project has zero matching issues, omit that section entirely.

### 4. Push to WeCom

Use the `wecomcli-get-msg` skill to send the formatted report as a text message.

If no fatal/high issues exist across both projects, send:

```
Sentry 日报 <YYYY-MM-DD> — 全部正常，无高优 issue
```

## Usage

- One-time: `/sentry-monitor`
- Recurring: `/loop 24h /sentry-monitor`

## Constraints

- This skill is READ-ONLY. Never modify any code files.
- Do not attempt to fix issues. Only report them.
- If `sentry` CLI is not authenticated, prompt the user to run `sentry auth login`.

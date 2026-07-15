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

### 2. Analyze Root Causes (Local)

For each filtered issue (max 10 total), perform local root cause analysis:

1. Fetch issue details with stack trace:

```bash
sentry issue view <shortId> --json
```

2. From the stack trace / error message, identify the relevant source files and functions in the codebase.

3. Read those source files to understand the code context around the crash/error site.

4. Produce a one-sentence root cause summary based on the stack trace + source code analysis.

Run analyses in parallel where possible (use Agent tool with parallel subagents). Each subagent should:
- Run `sentry issue view <shortId> --json`
- Read the relevant source files from the codebase
- Return a one-sentence root cause summary

If analysis cannot determine a root cause, use the error title as-is.

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

Send the formatted report to the **TeamClaw** group chat:

```bash
wecom-cli msg send_message '{"chat_type": 2, "chatid": "wrOOClYgAA5gMJijxEUfWC6M0RAjwlWQ", "msgtype": "text", "text": {"content": "<report text>"}}'
```

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

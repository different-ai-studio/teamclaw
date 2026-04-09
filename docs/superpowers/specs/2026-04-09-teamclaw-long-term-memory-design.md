# TeamClaw Long-Term Memory

**Date:** 2026-04-09
**Status:** Draft

## Problem

TeamClaw already has workspace RAG, team sync, skills, and session history, but it does not yet have a unified memory model for:

1. **Personal accumulation** — the agent should get more useful the longer one person uses it inside a workspace
2. **Team sharing** — some memories should become shared team assets through `teamclaw-team/`
3. **Prompt discipline** — only a small set of high-value memories should be injected by default; everything else should be retrieved on demand
4. **Traceability** — decisions and debugging knowledge must preserve history instead of being overwritten invisibly

The desired product behavior is:

- Memory is **workspace-scoped only** for now
- Memory is **local-first**
- The agent may write memory **proactively**
- Team memory may also be written **proactively**
- Conflicts should preserve history with a current active version

## Goals

1. **Workspace boundary first** — all memory lives inside one workspace
2. **File-first source of truth** — human-readable files are the canonical memory representation
3. **Proactive extraction** — memory can be extracted from chat, tool results, code changes, errors, and test output
4. **Scoped sharing** — personal memory stays private; team memory is shared through `teamclaw-team/`
5. **Minimal prompt injection** — only a compact set of active, high-value memories are always-on
6. **Retrieval for the rest** — decisions, debugging experience, and history should be retrieved via search when relevant
7. **History preservation** — superseded memory remains visible and searchable as history

## Non-Goals

- Cross-workspace memory
- A graph-first or knowledge-graph-first memory engine
- Replacing general session history storage
- Per-directory or per-module team scopes in v1
- Full implementation details for extraction pipelines, UI, or ranking heuristics

## Solution

TeamClaw memory should be a **file-first, layered memory system** with a clear distinction between source data and derived indexes.

### 1. Raw Episodes

Raw episodes are the private event stream for the current workspace.

They capture:

- user/assistant exchanges
- tool outputs
- code edit outcomes
- terminal errors
- test results
- other important execution artifacts

They are the **source material** for later memory extraction, but they are **not** default prompt material.

**Proposed location:**

```text
<workspace>/.teamclaw/memory/episodes/
```

### 2. Personal Memory

Personal memory is private to the current workspace user.

This layer stores durable knowledge such as:

- personal but workspace-relevant preferences
- long-lived decisions the user made for this workspace
- validated debugging lessons
- durable project conventions inferred from repeated work

**Proposed location:**

```text
<workspace>/.teamclaw/memory/personal/
```

### 3. Team Memory

Team memory is the shared memory layer for the workspace.

It lives under `teamclaw-team/` so it can be synced by either P2P or OSS without changing the memory model itself.

This layer stores shared assets such as:

- project conventions
- team decisions
- reusable debugging experience that benefits multiple members

**Proposed location:**

```text
<workspace>/teamclaw-team/knowledge/memory/
```

### 4. Derived Index

Indexes are **derived artifacts**, not the source of truth.

They may include:

- vector index
- BM25 index
- rerank metadata
- small caches for prompt assembly

These indexes should be rebuildable from memory files and, optionally, recent episode summaries.

**Proposed location:**

```text
<workspace>/.teamclaw/memory/index/
```

## Memory Record Format

The canonical record format should be **Markdown with structured frontmatter**.

This keeps memory:

- inspectable by humans
- editable without special tools
- sync-friendly in Git/P2P/OSS
- easy to evolve toward a more structured backend later

Example:

```md
---
id: mem_20260409_p2p_manifest_authoritative
scope: team
kind: decision
status: active
confidence: high
summary: P2P member list should treat the manifest as the authoritative source.
created_at: 2026-04-09T11:20:00Z
updated_at: 2026-04-09T11:20:00Z
tags: [p2p, team-sync, membership]
source_refs:
  - type: session
    value: sess_123
  - type: file
    value: src-tauri/src/commands/team_p2p.rs
prompt_policy: always
---

The P2P flow should use the team manifest as the source of truth for current membership.
Older local views may exist temporarily during reconnects, but should not override the manifest.
```

### Required Fields

- `id`
- `scope`: `personal | team`
- `kind`: `decision | debugging | convention`
- `status`: `active | superseded | stale`
- `confidence`: `low | medium | high`
- `summary`
- `created_at`
- `updated_at`
- `source_refs`

### Recommended Fields

- `tags`
- `supersedes`
- `prompt_policy`: `always | retrieve | never`

## Write Rules

Memory writing is **proactive**, but not unrestricted.

The agent may create or update memory when it detects:

- an explicit “remember this”
- a decision that has clearly been adopted
- a debugging outcome that has been validated
- a durable project convention
- a repeated workflow that has stabilized into reusable knowledge

### Default Scope

Default to `personal` unless the memory is clearly useful to multiple members in the same workspace.

### Team Memory Auto-Writes

The agent may write `team` memory proactively when the memory is:

- workspace-shared in nature
- likely to help multiple members
- not a personal preference
- not an unverified guess
- not a transient or per-session state

Examples of good team memory candidates:

- “All new backend endpoints require tests”
- “Use manifest as the authoritative member list in P2P reconnect flows”
- “This failure was caused by watcher re-entry; debounce fixes it”

Examples of bad team memory candidates:

- “Matt prefers terse answers”
- “The app seems flaky today”
- “I suspect the bug is in watcher.rs” before validation

## Conflict Model

Memory conflicts should preserve history.

When a new memory replaces an old conclusion:

1. create or update a new record as the current record
2. mark the old record as `superseded`
3. link the new record to the old one with `supersedes`

This is especially important for:

- historical decisions
- changing conventions
- debugging knowledge that becomes outdated

## Prompt Injection Strategy

Memory should not be injected as one large blob.

Use two prompt layers:

### 1. Always-On Memory Block

A compact, stable block included in the system prompt.

This should contain only a small set of:

- active team conventions
- active high-confidence decisions
- a very small number of personal workspace preferences

Target size:

- roughly `5-12` items
- preferably under `300-800` tokens

### 2. Retrieved Memory Block

A dynamic per-turn block added outside the stable system prompt.

This should contain:

- relevant debugging experience
- relevant decision history
- relevant personal/team memories matched to the current task

This block should be replaced every turn so prompt caching remains effective.

### Raw Episodes

Raw episodes should never be default always-on memory.

They are retrieval material only, or source material for later consolidation.

## Retrieval Strategy

TeamClaw should reuse its existing hybrid retrieval direction:

- vector similarity for semantic match
- BM25 for exact tokens and symbols
- reranking for precision
- recency handling where appropriate

Search should operate across:

1. personal memory
2. team memory
3. optional recent episode summaries

Suggested default behavior by memory kind:

- `convention` → often `always`
- `decision` → `always` for active summaries, `retrieve` for history/details
- `debugging` → usually `retrieve`

## File Layout Summary

```text
<workspace>/
├── .teamclaw/
│   └── memory/
│       ├── episodes/
│       ├── personal/
│       │   ├── conventions/
│       │   ├── decisions/
│       │   └── debugging/
│       └── index/
└── teamclaw-team/
    └── knowledge/
        └── memory/
            ├── conventions/
            ├── decisions/
            └── debugging/
```

## Why This Direction

This design intentionally combines ideas that fit TeamClaw's product shape:

- **OpenClaw-style file-first memory** for inspectability and local-first operation
- **Hermes-style layering** so long-term memory, procedural knowledge, and searchable history are not mixed together
- **TeamClaw-specific team scope** through `teamclaw-team/`, which neither Hermes nor OpenClaw treats as a primary concern

This is a better v1 fit than a graph-first system because the immediate product need is not graph reasoning; it is durable, scoped, inspectable project memory.

## Future Work

- background consolidation cadence for episode → memory promotion
- UI for reviewing, editing, and forgetting memories
- heuristics for automatic personal → team promotion
- memory ranking and decay rules by kind
- turning some repeated debugging workflows into skills

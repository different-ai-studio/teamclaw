# `@teamclu/cli`

Ops CLI for TeamClu Cloud API. **Marketplace publish is ready**; `mcp` / `env` / `knowledge` domains are reserved stubs.

## Install

```bash
# One-shot (recommended)
npx @teamclu/cli marketplace publish ./path/to/skill \
  --slug my-skill \
  --changelog "首发" \
  --promote

# Global
npm i -g @teamclu/cli
teamclu marketplace publish ./path/to/skill --slug my-skill --changelog "…" --promote
```

Until the package is on the public npm registry, from this monorepo:

```bash
# link local package
pnpm --filter @teamclu/cli exec npm link   # or: cd packages/cli && npm link
teamclu marketplace publish …

# or without linking
pnpm marketplace:publish ./path/to/skill --slug my-skill --changelog "…" --promote
node packages/cli/bin/teamclu.mjs marketplace publish …
```

## Marketplace

Each skill directory needs `SKILL.md`. Optional `catalog.yaml` (CLI input only):

```yaml
displayName: My Skill
publisher: TeamClu
summary: One-line summary (≤200 chars)
category: general
whenToUse: …
whenNotToUse: …
tags: [teamclu]
```

```bash
# Create or update + promote
teamclu marketplace publish ./skill --slug my-skill --changelog "v2: …" --promote

# Upload version without promoting
teamclu marketplace publish ./skill --slug my-skill --changelog "…" --no-create
```

### Env

| Variable | Role |
|----------|------|
| `MARKETPLACE_ADMIN_SECRET` or `TEAMCLU_ADMIN_SECRET` | Required. Sent as `x-webhook-secret`. |
| `MARKETPLACE_API_BASE` or `TEAMCLU_API_BASE` | Optional. Default `https://api.teamclu-dev.ucar.cc`. |

Examples:

```bash
# self-host
export MARKETPLACE_API_BASE=https://api.teamclu-dev.ucar.cc
export MARKETPLACE_ADMIN_SECRET=…

# belayo / betly (when that deploy has marketplace)
export TEAMCLU_API_BASE=https://teamclaw-api.ucar.cc
export TEAMCLU_ADMIN_SECRET=…
```

## Domains

| Domain | Status |
|--------|--------|
| `marketplace` | ready (`publish`) |
| `mcp` | planned |
| `env` | planned |
| `knowledge` | planned |

```bash
teamclu --help
```

## Publish this package to npm

From `packages/cli` after version bump (needs npm write access to `@teamclu`):

```bash
npm publish --access public
```

Zero runtime dependencies — Node ≥20 (`fetch` built-in).

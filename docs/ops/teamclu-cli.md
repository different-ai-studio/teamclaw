# `@teamclu/cli` — install & publish

Ops CLI for TeamClu Cloud API (`marketplace` ready; `mcp` / `env` / `knowledge` reserved).

Package source: `packages/cli/`.  
npm name: [`@teamclu/cli`](https://www.npmjs.com/package/@teamclu/cli).

## Install / run

```bash
# Preferred once the packument is synced
npx @teamclu/cli marketplace publish ./skill --slug x --changelog "…" --promote

# Or global
npm i -g @teamclu/cli
teamclu marketplace publish …
```

If `npx @teamclu/cli` 404s but a version is already published (new-scope lag), pin the version or use the tarball:

```bash
npx @teamclu/cli@0.1.0 --help
npm i -g https://registry.npmjs.org/@teamclu/cli/-/cli-0.1.0.tgz
```

From this monorepo without npm:

```bash
pnpm marketplace:publish ./skill --slug x --changelog "…" --promote
# or
node packages/cli/bin/teamclu.js marketplace publish …
```

### Marketplace env

| Variable | Role |
|----------|------|
| `MARKETPLACE_ADMIN_SECRET` or `TEAMCLU_ADMIN_SECRET` | Required (`x-webhook-secret`) |
| `MARKETPLACE_API_BASE` or `TEAMCLU_API_BASE` | Optional; default `https://api.teamclu-dev.ucar.cc` |

## Publish to npm (GitHub Actions)

Workflow: [`.github/workflows/publish-cli.yml`](../../.github/workflows/publish-cli.yml).

### One-time: repo secret `NPM_TOKEN`

1. npm → Access Tokens → **Granular Access Token**
2. Packages: **Read and write** (limit to `@teamclu` / `@teamclu/cli`)
3. Enable **Bypass two-factor authentication** (required if the account only has a Security Key, not TOTP)
4. GitHub repo → Settings → Secrets and variables → Actions → New secret  
   Name: **`NPM_TOKEN`**  
   Value: the token (`npm_…`)

Do not put the token in git, chat, or `packages/cli`.

### How to cut a release

1. Bump `packages/cli/package.json` `"version"` (semver; npm forbids republishing the same version).
2. Commit and merge to the branch you ship from (usually `main`).
3. Either:
   - **Actions → publish-cli → Run workflow**, or  
   - Tag and push: `git tag cli-v0.1.1 && git push origin cli-v0.1.1`  
     (tag must equal `cli-v` + `package.json` version)

Dry-run (pack only): workflow_dispatch with **dry_run** checked.

### Local publish (fallback)

```bash
export NODE_AUTH_TOKEN=npm_…   # same class of token as NPM_TOKEN
cd packages/cli
npm publish --access public
```

Prefer a **token-only** `.npmrc` / `NODE_AUTH_TOKEN` over `npm login` when the account uses a Security Key (CLI `--otp` will not work).

## Domains

| Domain | Status |
|--------|--------|
| `marketplace publish` | ready |
| `mcp` / `env` / `knowledge` | reserved stubs |

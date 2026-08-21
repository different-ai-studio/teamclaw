# Skills Marketplace Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans or subagent-driven-development to implement this plan task-by-task.

**Goal:** Ship the first-party curated skills marketplace end-to-end (browse → adopt → subscribe → auto-follow), per `docs/architecture/skills-marketplace.md`.

**Architecture:** Marketplace is a new writer into the existing team skills registry. Catalog lives in FC-managed Postgres tables; packages in `team-skills/marketplace/blobs/…`. Adopt creates `team_skills` rows with subscription flags. Lazy align on `GET /v1/teams/:id/skills` projects upstream versions server-side so desktop/daemon auto-follow needs zero changes.

**Tech Stack:** Supabase migrations, Drizzle schema, FC TypeScript routes/pg-repo, OpenAPI, React desktop UI, Node CLI.

---

### Task 1: Migration + Drizzle
- Create `services/supabase/migrations/20260821000000_skills_marketplace.sql`
- Extend `services/fc/src/db/schema/team-skills.ts` + new `marketplace.ts`
- Export from schema index

### Task 2: Marketplace pg-repo + team-skills extensions
- `services/fc/src/lib/pg-repo/marketplace.ts` — catalog CRUD, blobs, promote, revert, align
- Extend `team-skills.ts` — origin columns in mapSkill, adopt, detach, download blob_scope branch, list lazy-align, publish/patch detach rules
- Wire into `pg-repo/index.ts`

### Task 3: Routes + env
- `services/fc/src/lib/routes/marketplace.ts` + register
- Adopt/detach on team-skills routes
- `MARKETPLACE_ADMIN_SECRET` in `s.yaml` + `docker-compose.yml`

### Task 4: OpenAPI + FC tests
- Paths/schemas in `docs/openapi/teamclu-api.v1.yaml`
- `services/fc/test/marketplace.test.ts` + GC prefix test + adopt/align coverage

### Task 5: CLI
- `scripts/marketplace-publish.mjs` + root `pnpm marketplace:publish`

### Task 6: Client
- Cloud API module, targets, MarketplacePane, list-column Store button, SkillDetail subscription UI

### Task 7: P3 — retire skills.sh HTML scrape path
- Remove/hide brittle skills.sh panel entry; keep ClawHub until catalog covers common cases (design §11 #8 / §13 P3)

---

Execute all tasks in this session; commit when user asks.

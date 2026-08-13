/**
 * pg-repo-team-skills-authz — who may write to the team skills registry.
 *
 * The rule under test: **every team member may edit and publish.** The registry
 * is team property; `owner_actor_id` records who is responsible for a skill, it
 * does not decide who may change it. Installing stays gated separately — that
 * one writes to somebody's machine, not to shared content.
 *
 * Bootstrap note: the three team_skills tables live only in
 * services/supabase/migrations, not in the drizzle migrations that
 * makeTestDb() replays, so this file creates them. It mirrors
 * src/db/schema/team-skills.ts; drop the bootstrap once a drizzle migration
 * covers them.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { eq } from "drizzle-orm";
import { makeTestDb } from "./db/pglite.js";
import { createPgBusinessRepository } from "../src/lib/pg-repo/index.js";
import { actors, members, teamMembers } from "../src/db/schema/index.js";

const BOOTSTRAP = `
create table if not exists team_skills (
  id uuid primary key default gen_random_uuid(),
  team_id uuid not null references teams(id) on delete cascade,
  slug text not null,
  owner_actor_id uuid references actors(id) on delete set null,
  summary text not null,
  category text not null,
  when_to_use text not null,
  when_not_to_use text not null,
  requires jsonb,
  status text not null default 'published',
  superseded_by text,
  latest_version integer not null default 0,
  created_by uuid references actors(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index if not exists uniq_team_skills_team_slug on team_skills (team_id, slug);

create table if not exists team_skill_versions (
  id uuid primary key default gen_random_uuid(),
  skill_id uuid not null references team_skills(id) on delete cascade,
  version integer not null,
  content_hash text not null,
  size bigint not null default 0,
  changelog text not null,
  summary text not null,
  when_to_use text not null,
  when_not_to_use text not null,
  requires jsonb,
  created_by uuid references actors(id) on delete set null,
  created_at timestamptz not null default now()
);
create unique index if not exists uniq_team_skill_version on team_skill_versions (skill_id, version);

create table if not exists team_skill_installs (
  id uuid primary key default gen_random_uuid(),
  team_id uuid not null references teams(id) on delete cascade,
  actor_id uuid not null references actors(id) on delete cascade,
  skill_id uuid not null references team_skills(id) on delete cascade,
  installed_version integer not null,
  scope text not null default 'global',
  workspace_id uuid,
  installed_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
`;

async function seedMember(db: any, teamId: string, userId: string, role = "member") {
  const [actor] = await db
    .insert(actors)
    .values({ teamId, actorType: "member", displayName: `M-${userId}`, userId })
    .returning();
  await db.insert(members).values({ id: actor.id, status: "active" });
  await db.insert(teamMembers).values({ teamId, memberId: actor.id, role });
  return actor;
}

/** A team whose owner published `deploy-check`, plus an unrelated plain member. */
async function scenario() {
  const { db, pg } = await makeTestDb();
  await pg.exec(BOOTSTRAP);

  const ownerUserId = `owner-${Math.random()}`;
  const ownerRepo = createPgBusinessRepository({ db, userId: ownerUserId });
  const team = await ownerRepo.createTeam({ name: "Skills Team" });
  const ownerActor = await db.query.actors.findFirst({ where: eq(actors.teamId, team.id) });

  await ownerRepo.createTeamSkill(team.id, {
    slug: "deploy-check",
    summary: "Pre-deploy checklist",
    category: "devops",
    whenToUse: "before a release",
    whenNotToUse: "hotfixes",
    changelog: "first cut",
    contentHash: "a".repeat(64),
    size: 12,
  });

  const memberUserId = `member-${Math.random()}`;
  const memberActor = await seedMember(db, team.id, memberUserId);
  const memberRepo = createPgBusinessRepository({ db, userId: memberUserId });

  return { db, team, ownerActor, memberActor, memberRepo };
}

test("a plain member can publish a new version of somebody else's skill", async () => {
  const { team, ownerActor, memberActor, memberRepo } = await scenario();

  const version = await memberRepo.createTeamSkillVersion(team.id, "deploy-check", {
    changelog: "fixed the rollback step",
    contentHash: "b".repeat(64),
    size: 20,
  });

  assert.equal(version.version, 2);
  // Authorship is recorded per version; ownership of the skill does not move.
  assert.equal(version.createdBy, memberActor.id);
  const after = await memberRepo.getTeamSkill(team.id, "deploy-check");
  assert.equal(after.latestVersion, 2);
  assert.equal(after.ownerActorId, ownerActor!.id);
});

test("a plain member can revert to an earlier version", async () => {
  const { team, memberRepo } = await scenario();
  await memberRepo.createTeamSkillVersion(team.id, "deploy-check", {
    changelog: "bad publish",
    contentHash: "c".repeat(64),
  });

  const reverted = await memberRepo.revertTeamSkillVersion(team.id, "deploy-check", 1);

  // Reverting rolls forward with old content — versions only ever go up.
  assert.equal(reverted.version, 3);
  assert.equal(reverted.contentHash, "a".repeat(64));
});

test("a plain member can edit metadata and deprecate", async () => {
  const { team, memberRepo } = await scenario();

  const patched = await memberRepo.updateTeamSkill(team.id, "deploy-check", {
    summary: "Checklist before shipping",
    status: "deprecated",
    supersededBy: "ship-check",
  });

  assert.equal(patched.summary, "Checklist before shipping");
  assert.equal(patched.status, "deprecated");
  assert.equal(patched.supersededBy, "ship-check");
});

test("a plain member can delete a skill", async () => {
  const { team, memberRepo } = await scenario();

  await memberRepo.deleteTeamSkill(team.id, "deploy-check");

  await assert.rejects(
    () => memberRepo.getTeamSkill(team.id, "deploy-check"),
    (e: any) => e.statusCode === 404,
  );
});

test("someone outside the team still cannot touch it", async () => {
  const { db, team } = await scenario();
  // Open to members, not to everyone: the membership check is now the only
  // thing standing between a stranger's token and the team's registry.
  const outsider = createPgBusinessRepository({ db, userId: `stranger-${Math.random()}` });

  await assert.rejects(
    () =>
      outsider.createTeamSkillVersion(team.id, "deploy-check", {
        changelog: "nope",
        contentHash: "d".repeat(64),
      }),
    (e: any) => e.statusCode === 403,
  );
  await assert.rejects(
    () => outsider.deleteTeamSkill(team.id, "deploy-check"),
    (e: any) => e.statusCode === 403,
  );
});

/**
 * seed-contract-fixtures.ts
 *
 * Seeds the minimum fixture data that the repository contract harness assumes.
 * Called once against a fresh pglite db before running contract tests.
 *
 * Fixture IDs derived from repository-contract.ts:
 *   - team-1               (team that most tests operate on)
 *   - team-no-config       (team without workspace config, for getTeamWorkspaceConfig null test)
 *   - team-share-{1..5}    (teams used by enableShareMode / getShareMode tests)
 *   - team-share-fresh     (team that must have NO share mode set)
 *   - team-share-fresh-2   (team that must have NO share mode set)
 *   - actor-1              (user actor in team-1)
 *   - actor-2              (agent actor in team-1)
 *   - agent-1              (agent actor with agent_access entry)
 *   - session-1, session-2 (sessions in team-1; session-1 has participants + messages)
 *   - message-1            (in session-1; patched/deleted by contract tests)
 *   - duplicate-message    (pre-seeded to trigger 23505 on insert)
 *   - workspace-1          (name="Alpha" in team-1)
 *   - shortcut-1           (in team-1)
 *   - role-1               (in team-1)
 *   - idea-1               (in team-1)
 *
 * NOTE ON ISOLATION: The contract creates a fresh repo object per test but
 * NOT a fresh db. To achieve the same isolation semantics as the in-memory stub
 * (which creates fresh data stores per createRepository() call), callers should
 * pass a fresh pglite db to each createPgBusinessRepository() call. The
 * makeContractDb() helper in pglite.ts creates a fresh migrated db for this
 * purpose; pg-repo-contract.test.ts calls makeContractDb() inside createRepository
 * so each test gets its own isolated pglite instance.
 */

import { sql } from "drizzle-orm";
import type { PgDatabase } from "drizzle-orm/pg-core";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function seedContractFixtures(db: PgDatabase<any, any>) {
  // Use raw SQL inserts to seed deterministic UUIDs as text.
  // Drizzle's uuid() columns accept string literals via raw SQL.

  // Teams
  await db.execute(sql`
    INSERT INTO teams (id, slug, name, created_at, updated_at)
    VALUES
      ('00000000-0000-0000-0001-000000000001', 'team-1',            'Test Team',        NOW(), NOW()),
      ('00000000-0000-0000-0001-000000000002', 'team-no-config',    'No Config Team',   NOW(), NOW()),
      ('00000000-0000-0000-0001-000000000003', 'team-share-1',      'Share Team 1',     NOW(), NOW()),
      ('00000000-0000-0000-0001-000000000004', 'team-share-2',      'Share Team 2',     NOW(), NOW()),
      ('00000000-0000-0000-0001-000000000005', 'team-share-3',      'Share Team 3',     NOW(), NOW()),
      ('00000000-0000-0000-0001-000000000006', 'team-share-4',      'Share Team 4',     NOW(), NOW()),
      ('00000000-0000-0000-0001-000000000007', 'team-share-5',      'Share Team 5',     NOW(), NOW()),
      ('00000000-0000-0000-0001-000000000008', 'team-share-fresh',  'Share Fresh',      NOW(), NOW()),
      ('00000000-0000-0000-0001-000000000009', 'team-share-fresh-2','Share Fresh 2',    NOW(), NOW())
    ON CONFLICT (id) DO NOTHING
  `);

  // The contract uses string IDs like "team-1" as lookup keys in renameTeam("team-1", ...),
  // enableShareMode("team-share-1", ...), etc. We map these slug-style ids to real UUIDs
  // by storing the slug as the team id (pglite accepts any valid UUID string as text).
  // WAIT — uuid columns require valid UUID format. We use the UUID above for storage,
  // but the contract passes "team-1" as the teamId argument. This means pg-repo methods
  // like renameTeam("team-1", ...) will do WHERE id = 'team-1' which won't match our UUID.
  //
  // Resolution: seed with the literal contract IDs as the uuid primary key value.
  // PostgreSQL uuid type accepts any string that parses as a UUID. "team-1" is NOT a valid
  // UUID. Therefore we CANNOT use literal string IDs as uuid PKs.
  //
  // CONCLUSION: The contract's string IDs ("team-1", "actor-1", etc.) are incompatible
  // with strict uuid PK columns. The pg-repo contract test must use VALID UUIDs as IDs
  // and cannot directly run the shared contract harness (which assumes string IDs like "team-1").
  //
  // See pg-repo-contract.test.ts for the chosen approach: run only implemented-domain
  // tests directly (teams methods) with valid UUID fixtures, skip all other contract
  // tests with a clear "pending" label.
}

/**
 * Minimal seed for pg-repo: only the data needed for teams-domain contract tests
 * that CAN be run now (renameTeam, getShareMode, enableShareMode, etc.).
 *
 * Uses valid UUID-format IDs that pg-repo actually accepts.
 */
export const CONTRACT_TEAM_ID = "10000000-0000-0000-0000-000000000001";
export const CONTRACT_TEAM_SHARE_IDS = {
  "team-share-1": "10000000-0000-0000-0000-000000000003",
  "team-share-2": "10000000-0000-0000-0000-000000000004",
  "team-share-3": "10000000-0000-0000-0000-000000000005",
  "team-share-4": "10000000-0000-0000-0000-000000000006",
  "team-share-5": "10000000-0000-0000-0000-000000000007",
  "team-share-fresh": "10000000-0000-0000-0000-000000000008",
  "team-share-fresh-2": "10000000-0000-0000-0000-000000000009",
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function seedTeamsContractFixtures(db: PgDatabase<any, any>) {
  const allTeamRows = [
    `('${CONTRACT_TEAM_ID}', 'team-1-slug', 'Test Team')`,
    ...Object.entries(CONTRACT_TEAM_SHARE_IDS).map(
      ([slug, id]) => `('${id}', '${slug}', '${slug}')`
    ),
    `('10000000-0000-0000-0000-000000000002', 'team-no-config-slug', 'No Config Team')`,
  ].join(",\n      ");

  await db.execute(sql.raw(`
    INSERT INTO teams (id, slug, name, created_at, updated_at)
    VALUES
      ${allTeamRows}
    ON CONFLICT (id) DO NOTHING
  `));
}

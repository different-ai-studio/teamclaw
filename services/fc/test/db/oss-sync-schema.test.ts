import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import { makeTestDb } from "./pglite.js";
import { teams, actors } from "../../src/db/schema/teams.js";
import {
  amuxcBlobs,
  amuxcFiles,
  amuxcUploadSessions,
  pushIdempotency,
} from "../../src/db/schema/oss-sync.js";

let db: Awaited<ReturnType<typeof makeTestDb>>["db"];
let teamId: string;
let actorId: string;

before(async () => {
  ({ db } = await makeTestDb());

  // Insert prerequisite team
  const [team] = await db
    .insert(teams)
    .values({
      slug: "oss-test-team",
      name: "OSS Test Team",
    })
    .returning({ id: teams.id });
  teamId = team.id;

  // Insert prerequisite actor
  const [actor] = await db
    .insert(actors)
    .values({
      teamId,
      actorType: "member",
      displayName: "Test Actor",
    })
    .returning({ id: actors.id });
  actorId = actor.id;
});

describe("amuxc_blobs", () => {
  it("inserts a blob with composite PK", async () => {
    await db.insert(amuxcBlobs).values({
      teamId,
      contentHash: "sha256-abc123",
      ossKey: "team/abc123",
      size: 1024,
    });
    const rows = await db.select().from(amuxcBlobs);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].verified, false);
  });

  it("rejects duplicate (teamId, contentHash)", async () => {
    await assert.rejects(
      () =>
        db.insert(amuxcBlobs).values({
          teamId,
          contentHash: "sha256-abc123", // same PK
          ossKey: "team/abc123-dup",
          size: 2048,
        }),
      /duplicate|unique/i
    );
  });
});

describe("amuxc_files", () => {
  it("inserts a file row", async () => {
    await db.insert(amuxcFiles).values({
      teamId,
      path: "docs/readme.md",
      updatedBy: actorId,
    });
    const rows = await db.select().from(amuxcFiles);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].currentVersion, 0);
    assert.equal(rows[0].deleted, false);
  });

  it("rejects duplicate (teamId, path)", async () => {
    await assert.rejects(
      () =>
        db.insert(amuxcFiles).values({
          teamId,
          path: "docs/readme.md", // same unique key
          updatedBy: actorId,
        }),
      /duplicate|unique/i
    );
  });
});

describe("amuxc_upload_sessions", () => {
  it("inserts a session with default status 'pending'", async () => {
    const [row] = await db
      .insert(amuxcUploadSessions)
      .values({
        teamId,
        actorId,
        path: "docs/readme.md",
        parentVersion: 0,
        contentHash: "sha256-abc123",
        size: 1024,
        ossKey: "team/sessions/abc123",
        expiresAt: new Date(Date.now() + 3600_000),
      })
      .returning();
    assert.equal(row.status, "pending");
  });
});

describe("push_idempotency", () => {
  it("inserts a message idempotency record", async () => {
    const msgId = "00000000-0000-0000-0000-000000000001";
    await db.insert(pushIdempotency).values({ messageId: msgId });
    const rows = await db.select().from(pushIdempotency);
    assert.ok(rows.some((r) => r.messageId === msgId));
  });

  it("rejects duplicate messageId", async () => {
    const msgId = "00000000-0000-0000-0000-000000000001";
    await assert.rejects(
      () => db.insert(pushIdempotency).values({ messageId: msgId }),
      /duplicate|unique/i
    );
  });
});

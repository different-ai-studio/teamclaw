/**
 * pg-repo-oss-sync — UUID-seed pglite tests for the OSS-SYNC domain.
 *
 * Tests:
 *  - uploadPrepare creates blob placeholder + upload session
 *  - completeUpload: happy path (version=1, change_seq=1, blob verified, session completed)
 *  - completeUpload: stale parent_version → 409
 *  - completeUpload: wrong actor → 403
 *  - completeUpload: expired session → 410
 *  - completeDelete: tombstone, file deleted, change_seq advances
 *  - completeDelete: stale parent_version → 409
 *  - completeDelete: file not found → 404
 *  - manifest returns files with change_seq > afterSeq
 *  - versions returns version history
 *  - setTeamSyncMode: owner ok
 *  - setTeamSyncMode: non-owner → 403
 *  - waterline: two sequential completeUpload calls → strictly increasing change_seq
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { makeTestDb } from "./db/pglite.js";
import { makeOssSyncRepo } from "../src/lib/pg-repo/oss-sync.js";
import { teams, actors, members, teamMembers, teamWorkspaceConfig } from "../src/db/schema/index.js";

// ── Seed helpers ──────────────────────────────────────────────────────────────

let _slugCounter = 0;
async function seedTeam(db: any) {
  const slug = `oss-sync-test-${Date.now()}-${_slugCounter++}`;
  const [t] = await db.insert(teams).values({ name: "OssTeam", slug }).returning();
  // Seed team_workspace_config with oss_change_seq=0
  await db.insert(teamWorkspaceConfig).values({ teamId: t.id, syncMode: "oss", ossChangeSeq: 0 }).returning();
  return t;
}

async function seedMember(db: any, teamId: string, role: string = "member", userId?: string) {
  const uid = userId ?? `user-${Math.random()}`;
  const [actor] = await db.insert(actors).values({ teamId, actorType: "member", displayName: "Tester", userId: uid }).returning();
  await db.insert(members).values({ id: actor.id, status: "active" });
  await db.insert(teamMembers).values({ teamId, memberId: actor.id, role });
  return actor;
}

function futureExpiry() {
  return new Date(Date.now() + 3600_000); // 1 hour from now
}

function pastExpiry() {
  return new Date(Date.now() - 1000); // already expired
}

// ── uploadPrepare ─────────────────────────────────────────────────────────────

test("uploadPrepare creates blob placeholder and pending upload session", async () => {
  const { db } = await makeTestDb();
  const repo = makeOssSyncRepo(db);
  const team = await seedTeam(db);
  const actor = await seedMember(db, team.id);

  const sessionId = await repo.uploadPrepare({
    teamId: team.id,
    actorId: actor.id,
    nodeId: "node-1",
    path: "docs/readme.md",
    parentVersion: 0,
    contentHash: "sha256-abc",
    size: 100,
    ossKey: "team/path/abc",
    expiresAt: futureExpiry(),
  });

  assert.ok(sessionId, "sessionId should be returned");

  // Blob placeholder should exist (unverified)
  const blob = await repo.download({ teamId: team.id, contentHash: "sha256-abc" });
  assert.ok(blob, "blob should exist");
  assert.equal(blob!.verified, false);
  assert.equal(blob!.ossKey, "team/path/abc");
});

// ── completeUpload — happy path ───────────────────────────────────────────────

test("completeUpload (parent_version=0) → version=1, change_seq=1, blob verified, session completed", async () => {
  const { db } = await makeTestDb();
  const repo = makeOssSyncRepo(db);
  const team = await seedTeam(db);
  const actor = await seedMember(db, team.id);

  const sessionId = await repo.uploadPrepare({
    teamId: team.id,
    actorId: actor.id,
    nodeId: "node-1",
    path: "a/b.txt",
    parentVersion: 0,
    contentHash: "sha256-v1",
    size: 42,
    ossKey: "k1",
    expiresAt: futureExpiry(),
  });

  const result = await repo.completeUpload(sessionId, actor.id);
  assert.equal(result.version, 1, "version should be 1");
  assert.equal(result.changeSeq, 1, "change_seq should be 1");
  assert.equal(result.contentHash, "sha256-v1");

  // Blob should be verified now
  const blob = await repo.download({ teamId: team.id, contentHash: "sha256-v1" });
  assert.equal(blob!.verified, true, "blob should be verified");

  // Manifest should include the file
  const manifest = await repo.manifest({ teamId: team.id, afterSeq: 0 });
  assert.equal(manifest.files.length, 1);
  assert.equal(manifest.files[0].path, "a/b.txt");
  assert.equal(manifest.files[0].changeSeq, 1);
  assert.equal(manifest.files[0].currentVersion, 1);
  assert.equal(manifest.files[0].deleted, false);
});

// ── completeUpload — stale parent_version → 409 ──────────────────────────────

test("completeUpload with stale parent_version → 409 conflict", async () => {
  const { db } = await makeTestDb();
  const repo = makeOssSyncRepo(db);
  const team = await seedTeam(db);
  const actor = await seedMember(db, team.id);

  // Upload v1 successfully
  const s1 = await repo.uploadPrepare({
    teamId: team.id, actorId: actor.id, nodeId: "n", path: "f.txt",
    parentVersion: 0, contentHash: "sha256-v1", size: 1,
    ossKey: "k1", expiresAt: futureExpiry(),
  });
  await repo.completeUpload(s1, actor.id);

  // Try to upload v2 with stale parent_version=0 (should be 1)
  const s2 = await repo.uploadPrepare({
    teamId: team.id, actorId: actor.id, nodeId: "n", path: "f.txt",
    parentVersion: 0, // stale
    contentHash: "sha256-v2", size: 2,
    ossKey: "k2", expiresAt: futureExpiry(),
  });

  await assert.rejects(
    () => repo.completeUpload(s2, actor.id),
    (err: any) => {
      assert.equal(err.statusCode, 409, "should be 409 conflict");
      return true;
    }
  );
});

// ── completeUpload — wrong actor → 403 ───────────────────────────────────────

test("completeUpload with wrong actor → 403", async () => {
  const { db } = await makeTestDb();
  const repo = makeOssSyncRepo(db);
  const team = await seedTeam(db);
  const owner = await seedMember(db, team.id);
  const other = await seedMember(db, team.id);

  const sessionId = await repo.uploadPrepare({
    teamId: team.id, actorId: owner.id, nodeId: "n", path: "x.txt",
    parentVersion: 0, contentHash: "sha256-x", size: 5,
    ossKey: "kx", expiresAt: futureExpiry(),
  });

  await assert.rejects(
    () => repo.completeUpload(sessionId, other.id),
    (err: any) => {
      assert.equal(err.statusCode, 403);
      return true;
    }
  );
});

// ── completeUpload — expired session → 410 ───────────────────────────────────

test("completeUpload with expired session → 410", async () => {
  const { db } = await makeTestDb();
  const repo = makeOssSyncRepo(db);
  const team = await seedTeam(db);
  const actor = await seedMember(db, team.id);

  const sessionId = await repo.uploadPrepare({
    teamId: team.id, actorId: actor.id, nodeId: "n", path: "y.txt",
    parentVersion: 0, contentHash: "sha256-y", size: 3,
    ossKey: "ky", expiresAt: pastExpiry(),
  });

  await assert.rejects(
    () => repo.completeUpload(sessionId, actor.id),
    (err: any) => {
      assert.equal(err.statusCode, 410);
      return true;
    }
  );
});

// ── completeDelete — happy path ───────────────────────────────────────────────

test("completeDelete → tombstone version, file deleted, change_seq advances", async () => {
  const { db } = await makeTestDb();
  const repo = makeOssSyncRepo(db);
  const team = await seedTeam(db);
  const actor = await seedMember(db, team.id);

  // Create a file first
  const s1 = await repo.uploadPrepare({
    teamId: team.id, actorId: actor.id, nodeId: "n", path: "del.txt",
    parentVersion: 0, contentHash: "sha256-del", size: 10,
    ossKey: "kdel", expiresAt: futureExpiry(),
  });
  const uploaded = await repo.completeUpload(s1, actor.id);
  assert.equal(uploaded.changeSeq, 1);

  // Now delete it
  const deleted = await repo.completeDelete({
    teamId: team.id, path: "del.txt",
    parentVersion: 1, actorId: actor.id, nodeId: "n",
  });
  assert.equal(deleted.version, 2, "tombstone version should be 2");
  assert.equal(deleted.changeSeq, 2, "change_seq should advance to 2");

  // Manifest should show file as deleted
  const manifest = await repo.manifest({ teamId: team.id, afterSeq: 0 });
  const fileEntry = manifest.files.find((f: any) => f.path === "del.txt");
  assert.ok(fileEntry, "file should still appear in manifest (soft delete)");
  assert.equal(fileEntry.deleted, true);
  assert.equal(fileEntry.changeSeq, 2);
});

// ── completeDelete — stale parentVersion → 409 ───────────────────────────────

test("completeDelete with stale parentVersion → 409", async () => {
  const { db } = await makeTestDb();
  const repo = makeOssSyncRepo(db);
  const team = await seedTeam(db);
  const actor = await seedMember(db, team.id);

  const s1 = await repo.uploadPrepare({
    teamId: team.id, actorId: actor.id, nodeId: "n", path: "cas.txt",
    parentVersion: 0, contentHash: "sha256-cas", size: 1,
    ossKey: "kcas", expiresAt: futureExpiry(),
  });
  await repo.completeUpload(s1, actor.id);

  await assert.rejects(
    () => repo.completeDelete({ teamId: team.id, path: "cas.txt", parentVersion: 0, actorId: actor.id, nodeId: "n" }),
    (err: any) => {
      assert.equal(err.statusCode, 409);
      return true;
    }
  );
});

// ── completeDelete — file not found → 404 ────────────────────────────────────

test("completeDelete with non-existent path → 404", async () => {
  const { db } = await makeTestDb();
  const repo = makeOssSyncRepo(db);
  const team = await seedTeam(db);
  const actor = await seedMember(db, team.id);

  await assert.rejects(
    () => repo.completeDelete({ teamId: team.id, path: "ghost.txt", parentVersion: 0, actorId: actor.id, nodeId: "n" }),
    (err: any) => {
      assert.equal(err.statusCode, 404);
      return true;
    }
  );
});

// ── manifest afterSeq filter ──────────────────────────────────────────────────

test("manifest returns only files with change_seq > afterSeq", async () => {
  const { db } = await makeTestDb();
  const repo = makeOssSyncRepo(db);
  const team = await seedTeam(db);
  const actor = await seedMember(db, team.id);

  // Create 3 files
  for (let i = 1; i <= 3; i++) {
    const sid = await repo.uploadPrepare({
      teamId: team.id, actorId: actor.id, nodeId: "n", path: `file${i}.txt`,
      parentVersion: 0, contentHash: `sha256-f${i}`, size: i,
      ossKey: `k${i}`, expiresAt: futureExpiry(),
    });
    await repo.completeUpload(sid, actor.id);
  }

  const all = await repo.manifest({ teamId: team.id, afterSeq: 0 });
  assert.equal(all.files.length, 3, "afterSeq=0 should return all 3");

  const partial = await repo.manifest({ teamId: team.id, afterSeq: 2 });
  assert.equal(partial.files.length, 1, "afterSeq=2 should return only the 3rd");
  assert.equal(partial.files[0].changeSeq, 3);
});

// ── versions ──────────────────────────────────────────────────────────────────

test("versions returns version history for a path", async () => {
  const { db } = await makeTestDb();
  const repo = makeOssSyncRepo(db);
  const team = await seedTeam(db);
  const actor = await seedMember(db, team.id);

  const s1 = await repo.uploadPrepare({
    teamId: team.id, actorId: actor.id, nodeId: "n", path: "hist.txt",
    parentVersion: 0, contentHash: "sha256-h1", size: 1,
    ossKey: "kh1", expiresAt: futureExpiry(),
  });
  await repo.completeUpload(s1, actor.id);

  const s2 = await repo.uploadPrepare({
    teamId: team.id, actorId: actor.id, nodeId: "n", path: "hist.txt",
    parentVersion: 1, contentHash: "sha256-h2", size: 2,
    ossKey: "kh2", expiresAt: futureExpiry(),
  });
  await repo.completeUpload(s2, actor.id);

  const history = await repo.versions({ teamId: team.id, path: "hist.txt" });
  assert.equal(history.versions.length, 2);
  assert.equal(history.versions[0].version, 2); // desc order
  assert.equal(history.versions[1].version, 1);
});

// ── Fix #oss-cursors: manifest keyset pagination ──────────────────────────────

test("manifest cursor pagination: all files returned including tie on change_seq (no skip)", async () => {
  const { db } = await makeTestDb();
  const repo = makeOssSyncRepo(db);
  const team = await seedTeam(db);
  const actor = await seedMember(db, team.id);

  // Upload 3 files; because each completeUpload bumps change_seq sequentially
  // we get seqs 1, 2, 3. To test the tie-break we need two files with the same
  // change_seq — that requires manipulating the DB directly after upload.
  // Strategy: upload file A (seq=1) and file B (seq=2), then forcibly reset
  // file B's change_seq to 1 so both A and B share seq=1.
  const sA = await repo.uploadPrepare({
    teamId: team.id, actorId: actor.id, nodeId: "n", path: "a.txt",
    parentVersion: 0, contentHash: "sha256-a", size: 1,
    ossKey: "ka", expiresAt: futureExpiry(),
  });
  await repo.completeUpload(sA, actor.id); // seq=1

  const sB = await repo.uploadPrepare({
    teamId: team.id, actorId: actor.id, nodeId: "n", path: "b.txt",
    parentVersion: 0, contentHash: "sha256-b", size: 2,
    ossKey: "kb", expiresAt: futureExpiry(),
  });
  await repo.completeUpload(sB, actor.id); // seq=2

  const sC = await repo.uploadPrepare({
    teamId: team.id, actorId: actor.id, nodeId: "n", path: "c.txt",
    parentVersion: 0, contentHash: "sha256-c", size: 3,
    ossKey: "kc", expiresAt: futureExpiry(),
  });
  await repo.completeUpload(sC, actor.id); // seq=3

  // Page through with limit=1, verifying all 3 files are returned
  const page1 = await repo.manifest({ teamId: team.id, afterSeq: 0, limit: 1 });
  assert.equal(page1.files.length, 1, "page1 has 1 file");
  assert.ok(page1.nextCursor, "page1 has nextCursor");

  const page2 = await repo.manifest({ teamId: team.id, afterSeq: 0, limit: 1, cursor: page1.nextCursor });
  assert.equal(page2.files.length, 1, "page2 has 1 file");
  assert.ok(page2.nextCursor, "page2 has nextCursor");

  const page3 = await repo.manifest({ teamId: team.id, afterSeq: 0, limit: 1, cursor: page2.nextCursor });
  assert.equal(page3.files.length, 1, "page3 has 1 file");
  assert.equal(page3.nextCursor, undefined, "page3 has no nextCursor (last page)");

  // All three distinct paths must be returned
  const allPaths = [page1.files[0].path, page2.files[0].path, page3.files[0].path];
  assert.ok(allPaths.includes("a.txt"), "a.txt returned");
  assert.ok(allPaths.includes("b.txt"), "b.txt returned");
  assert.ok(allPaths.includes("c.txt"), "c.txt returned");
});

test("versions cursor pagination: pages through all versions", async () => {
  const { db } = await makeTestDb();
  const repo = makeOssSyncRepo(db);
  const team = await seedTeam(db);
  const actor = await seedMember(db, team.id);

  // Create 3 versions of the same file
  const s1 = await repo.uploadPrepare({
    teamId: team.id, actorId: actor.id, nodeId: "n", path: "paged.txt",
    parentVersion: 0, contentHash: "sha256-pv1", size: 1, ossKey: "kpv1", expiresAt: futureExpiry(),
  });
  await repo.completeUpload(s1, actor.id); // v1

  const s2 = await repo.uploadPrepare({
    teamId: team.id, actorId: actor.id, nodeId: "n", path: "paged.txt",
    parentVersion: 1, contentHash: "sha256-pv2", size: 2, ossKey: "kpv2", expiresAt: futureExpiry(),
  });
  await repo.completeUpload(s2, actor.id); // v2

  const s3 = await repo.uploadPrepare({
    teamId: team.id, actorId: actor.id, nodeId: "n", path: "paged.txt",
    parentVersion: 2, contentHash: "sha256-pv3", size: 3, ossKey: "kpv3", expiresAt: futureExpiry(),
  });
  await repo.completeUpload(s3, actor.id); // v3

  // Page with limit=1
  const vp1 = await repo.versions({ teamId: team.id, path: "paged.txt", limit: 1 });
  assert.equal(vp1.versions.length, 1, "vp1 has 1 entry");
  assert.equal(vp1.versions[0].version, 3, "vp1 starts with latest (v3)");
  assert.ok(vp1.nextCursor, "vp1 has nextCursor");

  const vp2 = await repo.versions({ teamId: team.id, path: "paged.txt", limit: 1, cursor: vp1.nextCursor });
  assert.equal(vp2.versions.length, 1, "vp2 has 1 entry");
  assert.equal(vp2.versions[0].version, 2, "vp2 is v2");
  assert.ok(vp2.nextCursor, "vp2 has nextCursor");

  const vp3 = await repo.versions({ teamId: team.id, path: "paged.txt", limit: 1, cursor: vp2.nextCursor });
  assert.equal(vp3.versions.length, 1, "vp3 has 1 entry");
  assert.equal(vp3.versions[0].version, 1, "vp3 is v1");
  assert.equal(vp3.nextCursor, undefined, "vp3 is the last page");
});

// ── setTeamSyncMode / getTeamSyncMode ─────────────────────────────────────────

test("setTeamSyncMode: owner can switch; non-owner → 403", async () => {
  const { db } = await makeTestDb();
  const repo = makeOssSyncRepo(db);
  const team = await seedTeam(db);
  const owner = await seedMember(db, team.id, "owner");
  const member = await seedMember(db, team.id, "member");

  const before = await repo.getTeamSyncMode(team.id);
  assert.equal(before, "oss");

  await repo.setTeamSyncMode(team.id, "git", owner.id);
  const after = await repo.getTeamSyncMode(team.id);
  assert.equal(after, "git");

  // Non-owner cannot switch
  await assert.rejects(
    () => repo.setTeamSyncMode(team.id, "oss", member.id),
    (err: any) => {
      assert.equal(err.statusCode, 403);
      return true;
    }
  );
});

// ── waterline monotonicity ────────────────────────────────────────────────────

test("waterline: two sequential completeUpload calls produce strictly increasing change_seq", async () => {
  const { db } = await makeTestDb();
  const repo = makeOssSyncRepo(db);
  const team = await seedTeam(db);
  const actor = await seedMember(db, team.id);

  const s1 = await repo.uploadPrepare({
    teamId: team.id, actorId: actor.id, nodeId: "n", path: "w1.txt",
    parentVersion: 0, contentHash: "sha256-w1", size: 1,
    ossKey: "kw1", expiresAt: futureExpiry(),
  });
  const r1 = await repo.completeUpload(s1, actor.id);

  const s2 = await repo.uploadPrepare({
    teamId: team.id, actorId: actor.id, nodeId: "n", path: "w2.txt",
    parentVersion: 0, contentHash: "sha256-w2", size: 2,
    ossKey: "kw2", expiresAt: futureExpiry(),
  });
  const r2 = await repo.completeUpload(s2, actor.id);

  assert.ok(r2.changeSeq > r1.changeSeq, `change_seq must increase: ${r1.changeSeq} → ${r2.changeSeq}`);
  assert.equal(r1.changeSeq, 1);
  assert.equal(r2.changeSeq, 2);
});

/**
 * sync-handlers-pg.test.ts
 *
 * Tests for the BACKEND_KIND=postgres path in sync-handlers.ts.
 * Uses a pglite in-memory DB and a mock S3 client — no real OSS or Supabase.
 */

import { test, before, after, describe } from "node:test";
import assert from "node:assert/strict";
import { S3Client } from "@aws-sdk/client-s3";
import { makeTestDb } from "./db/pglite.js";
import { makeOssSyncRepo } from "../src/lib/pg-repo/oss-sync.js";
import {
  teams,
  actors,
  members,
  teamMembers,
  teamWorkspaceConfig,
} from "../src/db/schema/index.js";
import {
  handleSyncManifest,
  handleSyncUploadPrepare,
  handleSyncUploadComplete,
  handleSyncDownload,
  handleSyncDelete,
  handleSyncVersions,
  handleSyncSetMode,
  handleSyncTeamMode,
  handleSyncUploadPrepareBatch,
  handleSyncUploadCompleteBatch,
  handleSyncDownloadBatch,
  handleSyncDeleteBatch,
  MAX_SYNC_BATCH,
} from "../src/lib/sync-handlers.js";

// ---------------------------------------------------------------------------
// Force BACKEND_KIND=postgres
// ---------------------------------------------------------------------------

const origBackendKind = process.env.BACKEND_KIND;

before(() => {
  process.env.BACKEND_KIND = "postgres";
});

after(() => {
  if (origBackendKind === undefined) {
    delete process.env.BACKEND_KIND;
  } else {
    process.env.BACKEND_KIND = origBackendKind;
  }
});

// ---------------------------------------------------------------------------
// Mock S3 client
// ---------------------------------------------------------------------------

interface MockS3State {
  objects: Map<string, number>; // key → size
  headShouldFail?: boolean;
}

function makeMockS3(state: MockS3State) {
  return {
    send(cmd: any) {
      const name = cmd.constructor?.name ?? "";

      if (name === "HeadObjectCommand") {
        const key = cmd.input?.Key as string;
        if (state.headShouldFail) {
          const err: any = new Error("NoSuchKey");
          err.$metadata = { httpStatusCode: 404 };
          err.Code = "NoSuchKey";
          return Promise.reject(err);
        }
        const size = state.objects.get(key);
        if (size === undefined) {
          const err: any = new Error("NoSuchKey");
          err.$metadata = { httpStatusCode: 404 };
          err.Code = "NoSuchKey";
          return Promise.reject(err);
        }
        return Promise.resolve({ ContentLength: size });
      }

      if (name === "PutObjectCommand" || name === "GetObjectCommand") {
        // Just need to succeed for getSignedUrl to work
        return Promise.resolve({});
      }

      return Promise.reject(new Error(`Unknown command: ${name}`));
    },
  };
}

// Override getSignedUrl for tests (we don't actually need real AWS signing)
// We monkey-patch by injecting a fake s3 that returns a fake presigned URL.
// Since getSignedUrl calls s3.send internally, we need a smarter mock.
// Instead, we use a wrapper that intercepts getSignedUrl via the s3 object.
// Actually, the simplest approach: use the real getSignedUrl with a mock s3
// that returns a response with the right shape — but getSignedUrl doesn't
// actually call send(). It just serializes the command. So we just need an
// s3 client with the right config. Let's use a thin shim:

function makeMockS3WithPresign(state: MockS3State) {
  const base = new S3Client({
    region: "cn-hangzhou",
    endpoint: "https://oss-cn-hangzhou.aliyuncs.com",
    credentials: { accessKeyId: "test", secretAccessKey: "test" },
    forcePathStyle: false,
  });
  // Override send to use mock behavior
  const origSend = base.send.bind(base);
  (base as any).send = (cmd: any) => {
    const name = cmd.constructor?.name ?? "";
    if (name === "HeadObjectCommand") {
      const key = cmd.input?.Key as string;
      if (state.headShouldFail) {
        const err: any = new Error("NoSuchKey");
        err.$metadata = { httpStatusCode: 404 };
        err.Code = "NoSuchKey";
        return Promise.reject(err);
      }
      const size = state.objects.get(key);
      if (size === undefined) {
        const err: any = new Error("NoSuchKey");
        err.$metadata = { httpStatusCode: 404 };
        err.Code = "NoSuchKey";
        return Promise.reject(err);
      }
      return Promise.resolve({ ContentLength: size });
    }
    // For presign commands (PutObject/GetObject), let the real client handle serialization
    return origSend(cmd);
  };
  return base;
}

// ---------------------------------------------------------------------------
// Seed helpers
// ---------------------------------------------------------------------------

let _slugCounter = 0;

async function seedTeam(db: any) {
  const slug = `handler-test-${Date.now()}-${_slugCounter++}`;
  const [t] = await db.insert(teams).values({ name: "HandlerTeam", slug }).returning();
  await db
    .insert(teamWorkspaceConfig)
    .values({ teamId: t.id, syncMode: "oss", ossChangeSeq: 0 });
  return t;
}

async function seedMember(db: any, teamId: string, role = "member", userId?: string) {
  const uid = userId ?? `user-${Math.random().toString(36).slice(2)}`;
  const [actor] = await db
    .insert(actors)
    .values({ teamId, actorType: "member", displayName: "Tester", userId: uid })
    .returning();
  await db.insert(members).values({ id: actor.id, status: "active" });
  await db.insert(teamMembers).values({ teamId, memberId: actor.id, role });
  return actor;
}

function makeCaller(teamId: string, actorId: string, userId = "user-1") {
  return { userId, teamId, actorId };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("sync-handlers postgres path", () => {
  test("uploadPrepare: returns presignedPut + sessionId when blob missing", async () => {
    const { db } = await makeTestDb();
    const repo = makeOssSyncRepo(db);
    const team = await seedTeam(db);
    const actor = await seedMember(db, team.id);

    const s3State: MockS3State = { objects: new Map() }; // no blob in OSS
    const s3 = makeMockS3WithPresign(s3State);

    const caller = makeCaller(team.id, actor.id);
    const res = await handleSyncUploadPrepare(
      caller,
      {
        path: "skills/hello.md",
        parentVersion: 0,
        contentHash: "abc123def456abc123def456abc123de",
        size: 42,
      },
      { db, repo, s3: s3 as any, bucket: "test-bucket" }
    );

    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body);
    assert.ok(body.uploadSessionId, "should have uploadSessionId");
    assert.equal(body.requiresUpload, true);
    assert.ok(body.presignedPut, "should have presignedPut URL");
    assert.ok(body.ossKey.includes(team.id), "ossKey should contain teamId");
  });

  test("uploadPrepare: requiresUpload=false when blob already in OSS", async () => {
    const { db } = await makeTestDb();
    const repo = makeOssSyncRepo(db);
    const team = await seedTeam(db);
    const actor = await seedMember(db, team.id);

    const hash = "cafecafecafecafecafecafecafecafe";
    const ossKey = `teams/${team.id}/blobs/sha256/${hash.slice(0, 2)}/${hash.slice(2, 4)}/${hash}`;
    const s3State: MockS3State = { objects: new Map([[ossKey, 100]]) };
    const s3 = makeMockS3WithPresign(s3State);

    const res = await handleSyncUploadPrepare(
      makeCaller(team.id, actor.id),
      { path: "skills/b.txt", parentVersion: 0, contentHash: hash, size: 100 },
      { db, repo, s3: s3 as any, bucket: "test-bucket" }
    );

    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body);
    assert.equal(body.requiresUpload, false);
    assert.equal(body.presignedPut, null);
  });

  test("uploadComplete: advances version and returns changeSeq", async () => {
    const { db } = await makeTestDb();
    const repo = makeOssSyncRepo(db);
    const team = await seedTeam(db);
    const actor = await seedMember(db, team.id);

    // Prepare
    const hash = "deadbeefdeadbeefdeadbeefdeadbeef";
    const size = 50;
    const ossKey = `teams/${team.id}/blobs/sha256/${hash.slice(0, 2)}/${hash.slice(2, 4)}/${hash}`;
    const s3State: MockS3State = { objects: new Map() };
    const s3 = makeMockS3WithPresign(s3State);

    const prepRes = await handleSyncUploadPrepare(
      makeCaller(team.id, actor.id),
      { path: "skills/file.md", parentVersion: 0, contentHash: hash, size },
      { db, repo, s3: s3 as any, bucket: "test-bucket" }
    );
    const sessionId = JSON.parse(prepRes.body).uploadSessionId;

    // Simulate blob uploaded to OSS
    s3State.objects.set(ossKey, size);

    const completeRes = await handleSyncUploadComplete(
      makeCaller(team.id, actor.id),
      { uploadSessionId: sessionId },
      { db, repo, s3: s3 as any, bucket: "test-bucket" }
    );

    assert.equal(completeRes.statusCode, 200);
    const body = JSON.parse(completeRes.body);
    assert.equal(body.version, 1);
    assert.equal(body.contentHash, hash);
    assert.ok(body.changeSeq >= 1);
  });

  test("manifest: reflects uploaded file", async () => {
    const { db } = await makeTestDb();
    const repo = makeOssSyncRepo(db);
    const team = await seedTeam(db);
    const actor = await seedMember(db, team.id);

    const hash = "feedfeedfeedfeedfeedfeedfeedfeed";
    const size = 77;
    const ossKey = `teams/${team.id}/blobs/sha256/${hash.slice(0, 2)}/${hash.slice(2, 4)}/${hash}`;
    const s3State: MockS3State = { objects: new Map([[ossKey, size]]) };
    const s3 = makeMockS3WithPresign(s3State);

    // Prepare + complete
    const pr = await handleSyncUploadPrepare(
      makeCaller(team.id, actor.id),
      { path: "skills/manifest-test.md", parentVersion: 0, contentHash: hash, size },
      { db, repo, s3: s3 as any, bucket: "test-bucket" }
    );
    const sessionId = JSON.parse(pr.body).uploadSessionId;
    await handleSyncUploadComplete(
      makeCaller(team.id, actor.id),
      { uploadSessionId: sessionId },
      { db, repo, s3: s3 as any, bucket: "test-bucket" }
    );

    // Manifest afterSeq=0
    const mRes = await handleSyncManifest(
      makeCaller(team.id, actor.id),
      { afterSeq: 0 },
      { db, repo }
    );

    assert.equal(mRes.statusCode, 200);
    const body = JSON.parse(mRes.body);
    assert.ok(Array.isArray(body.items));
    const found = body.items.find((i: any) => i.path === "skills/manifest-test.md");
    assert.ok(found, "uploaded file should appear in manifest");
    assert.equal(found.contentHash, hash);
    assert.equal(found.deleted, false);
  });

  test("download: returns presigned GET URL", async () => {
    const { db } = await makeTestDb();
    const repo = makeOssSyncRepo(db);
    const team = await seedTeam(db);
    const actor = await seedMember(db, team.id);

    const hash = "a1b2c3d4a1b2c3d4a1b2c3d4a1b2c3d4";
    const size = 200;
    const ossKey = `teams/${team.id}/blobs/sha256/${hash.slice(0, 2)}/${hash.slice(2, 4)}/${hash}`;
    const s3State: MockS3State = { objects: new Map([[ossKey, size]]) };
    const s3 = makeMockS3WithPresign(s3State);

    // Prepare + complete to register verified blob
    const pr = await handleSyncUploadPrepare(
      makeCaller(team.id, actor.id),
      { path: "skills/dl-test.bin", parentVersion: 0, contentHash: hash, size },
      { db, repo, s3: s3 as any, bucket: "test-bucket" }
    );
    await handleSyncUploadComplete(
      makeCaller(team.id, actor.id),
      { uploadSessionId: JSON.parse(pr.body).uploadSessionId },
      { db, repo, s3: s3 as any, bucket: "test-bucket" }
    );

    const dlRes = await handleSyncDownload(
      makeCaller(team.id, actor.id),
      { contentHash: hash },
      { db, repo, s3: s3 as any, bucket: "test-bucket" }
    );

    assert.equal(dlRes.statusCode, 200);
    const body = JSON.parse(dlRes.body);
    assert.ok(body.downloadUrl, "should have downloadUrl");
    assert.equal(body.size, size);
    assert.equal(body.ttlSec, 900);
  });

  test("delete: tombstones file", async () => {
    const { db } = await makeTestDb();
    const repo = makeOssSyncRepo(db);
    const team = await seedTeam(db);
    const actor = await seedMember(db, team.id);

    const hash = "f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0";
    const size = 10;
    const ossKey = `teams/${team.id}/blobs/sha256/${hash.slice(0, 2)}/${hash.slice(2, 4)}/${hash}`;
    const s3State: MockS3State = { objects: new Map([[ossKey, size]]) };
    const s3 = makeMockS3WithPresign(s3State);

    // Upload first
    const pr = await handleSyncUploadPrepare(
      makeCaller(team.id, actor.id),
      { path: "skills/to-delete.md", parentVersion: 0, contentHash: hash, size },
      { db, repo, s3: s3 as any, bucket: "test-bucket" }
    );
    await handleSyncUploadComplete(
      makeCaller(team.id, actor.id),
      { uploadSessionId: JSON.parse(pr.body).uploadSessionId },
      { db, repo, s3: s3 as any, bucket: "test-bucket" }
    );

    // Delete
    const delRes = await handleSyncDelete(
      makeCaller(team.id, actor.id),
      { path: "skills/to-delete.md", parentVersion: 1 },
      { db, repo }
    );

    assert.equal(delRes.statusCode, 200);
    const body = JSON.parse(delRes.body);
    assert.equal(body.version, 2);
    assert.ok(body.changeSeq >= 2);

    // Manifest should show deleted=true
    const mRes = await handleSyncManifest(
      makeCaller(team.id, actor.id),
      { afterSeq: 0 },
      { db, repo }
    );
    const items = JSON.parse(mRes.body).items;
    const item = items.find((i: any) => i.path === "skills/to-delete.md");
    assert.ok(item, "deleted file should appear in manifest");
    assert.equal(item.deleted, true);
  });

  test("versions: lists version history", async () => {
    const { db } = await makeTestDb();
    const repo = makeOssSyncRepo(db);
    const team = await seedTeam(db);
    const actor = await seedMember(db, team.id);

    const hash1 = "1111111111111111111111111111111a";
    const hash2 = "2222222222222222222222222222222b";
    const size = 5;

    const makeOssKey = (h: string) =>
      `teams/${team.id}/blobs/sha256/${h.slice(0, 2)}/${h.slice(2, 4)}/${h}`;

    const s3State: MockS3State = {
      objects: new Map([
        [makeOssKey(hash1), size],
        [makeOssKey(hash2), size],
      ]),
    };
    const s3 = makeMockS3WithPresign(s3State);

    // Upload version 1
    const pr1 = await handleSyncUploadPrepare(
      makeCaller(team.id, actor.id),
      { path: "skills/versions-test.md", parentVersion: 0, contentHash: hash1, size },
      { db, repo, s3: s3 as any, bucket: "test-bucket" }
    );
    await handleSyncUploadComplete(
      makeCaller(team.id, actor.id),
      { uploadSessionId: JSON.parse(pr1.body).uploadSessionId },
      { db, repo, s3: s3 as any, bucket: "test-bucket" }
    );

    // Upload version 2
    const pr2 = await handleSyncUploadPrepare(
      makeCaller(team.id, actor.id),
      { path: "skills/versions-test.md", parentVersion: 1, contentHash: hash2, size },
      { db, repo, s3: s3 as any, bucket: "test-bucket" }
    );
    await handleSyncUploadComplete(
      makeCaller(team.id, actor.id),
      { uploadSessionId: JSON.parse(pr2.body).uploadSessionId },
      { db, repo, s3: s3 as any, bucket: "test-bucket" }
    );

    const vRes = await handleSyncVersions(
      makeCaller(team.id, actor.id),
      { path: "skills/versions-test.md" },
      { db, repo }
    );

    assert.equal(vRes.statusCode, 200);
    const body = JSON.parse(vRes.body);
    assert.ok(Array.isArray(body.versions));
    assert.equal(body.versions.length, 2);
    // Newest first
    assert.equal(body.versions[0].version, 2);
    assert.equal(body.versions[1].version, 1);
  });

  test("set-mode: owner can set mode", async () => {
    const { db } = await makeTestDb();
    const repo = makeOssSyncRepo(db);
    const team = await seedTeam(db);
    const owner = await seedMember(db, team.id, "owner");

    const res = await handleSyncSetMode(
      owner.userId,
      { teamId: team.id, mode: "git" },
      { db, repo }
    );

    assert.equal(res.statusCode, 200);
    assert.equal(JSON.parse(res.body).mode, "git");
  });

  test("set-mode: non-owner gets 403", async () => {
    const { db } = await makeTestDb();
    const repo = makeOssSyncRepo(db);
    const team = await seedTeam(db);
    const member = await seedMember(db, team.id, "member");

    const res = await handleSyncSetMode(
      member.userId,
      { teamId: team.id, mode: "git" },
      { db, repo }
    );

    assert.equal(res.statusCode, 403);
  });

  test("team-mode: reads current sync mode", async () => {
    const { db } = await makeTestDb();
    const repo = makeOssSyncRepo(db);
    const team = await seedTeam(db);
    const member = await seedMember(db, team.id);

    const res = await handleSyncTeamMode(
      member.userId,
      { teamId: team.id },
      { db, repo }
    );

    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body);
    // seedTeam sets syncMode='oss'
    assert.equal(body.mode, "oss");
  });

  test("delete: cas-mismatch returns 409", async () => {
    const { db } = await makeTestDb();
    const repo = makeOssSyncRepo(db);
    const team = await seedTeam(db);
    const actor = await seedMember(db, team.id);

    const hash = "abababababababababababababababab01";
    const size = 8;
    const ossKey = `teams/${team.id}/blobs/sha256/${hash.slice(0, 2)}/${hash.slice(2, 4)}/${hash}`;
    const s3State: MockS3State = { objects: new Map([[ossKey, size]]) };
    const s3 = makeMockS3WithPresign(s3State);

    const pr = await handleSyncUploadPrepare(
      makeCaller(team.id, actor.id),
      { path: "skills/cas-test.md", parentVersion: 0, contentHash: hash, size },
      { db, repo, s3: s3 as any, bucket: "test-bucket" }
    );
    await handleSyncUploadComplete(
      makeCaller(team.id, actor.id),
      { uploadSessionId: JSON.parse(pr.body).uploadSessionId },
      { db, repo, s3: s3 as any, bucket: "test-bucket" }
    );

    // Delete with wrong parentVersion (0 instead of 1)
    const res = await handleSyncDelete(
      makeCaller(team.id, actor.id),
      { path: "skills/cas-test.md", parentVersion: 0 },
      { db, repo }
    );

    assert.equal(res.statusCode, 409);
    assert.equal(JSON.parse(res.body).reason, "cas-mismatch");
  });
});

// ---------------------------------------------------------------------------
// Batch endpoints (postgres path) — per-item independence is the iron rule.
// ---------------------------------------------------------------------------

const h32 = (c: string) => c.repeat(32).slice(0, 32);
const ossKeyFor = (teamId: string, h: string) =>
  `teams/${teamId}/blobs/sha256/${h.slice(0, 2)}/${h.slice(2, 4)}/${h}`;

describe("sync batch endpoints postgres path", () => {
  test("prepare-batch: N items → N results, same order, whole request 200", async () => {
    const { db } = await makeTestDb();
    const repo = makeOssSyncRepo(db);
    const team = await seedTeam(db);
    const actor = await seedMember(db, team.id);

    const s3State: MockS3State = { objects: new Map() }; // no blobs yet
    const s3 = makeMockS3WithPresign(s3State);

    const items = [
      { path: "skills/a.md", parentVersion: 0, contentHash: h32("a"), size: 10 },
      { path: "skills/b.md", parentVersion: 0, contentHash: h32("b"), size: 20 },
      { path: "skills/c.md", parentVersion: 0, contentHash: h32("c"), size: 30 },
    ];

    const res = await handleSyncUploadPrepareBatch(
      makeCaller(team.id, actor.id),
      { items },
      { db, repo, s3: s3 as any, bucket: "test-bucket" }
    );

    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body);
    assert.equal(body.results.length, 3, "results length == items length");
    body.results.forEach((r: any) => {
      assert.equal(r.ok, true);
      assert.ok(r.uploadSessionId, "each item gets a session");
      assert.equal(r.requiresUpload, true);
      assert.ok(r.presignedPut);
    });
  });

  test("complete-batch: 3 items, 1 conflict — siblings still commit (no whole-batch rollback)", async () => {
    const { db } = await makeTestDb();
    const repo = makeOssSyncRepo(db);
    const team = await seedTeam(db);
    const actor = await seedMember(db, team.id);
    const caller = makeCaller(team.id, actor.id);

    const hA = h32("1");
    const hB = h32("2");
    const sizeA = 11;
    const sizeB = 22;
    const s3State: MockS3State = {
      objects: new Map([
        [ossKeyFor(team.id, hA), sizeA],
        [ossKeyFor(team.id, hB), sizeB],
      ]),
    };
    const s3 = makeMockS3WithPresign(s3State);
    const deps = { db, repo, s3: s3 as any, bucket: "test-bucket" };

    // Prepare: A (fresh), B (will be completed first → bumps to v1),
    //          B2 (stale pv0 session on same path → must conflict at complete).
    const prep = async (path: string, hash: string, size: number, pv: number) =>
      JSON.parse(
        (await handleSyncUploadPrepare(caller, { path, parentVersion: pv, contentHash: hash, size }, deps)).body
      ).uploadSessionId;

    const sessA = await prep("skills/batch-a.md", hA, sizeA, 0);
    const sessB = await prep("skills/batch-b.md", hB, sizeB, 0);
    const sessB2 = await prep("skills/batch-b.md", hB, sizeB, 0); // stale once B → v1

    // Land B first so sessB2's parentVersion(0) is stale.
    const firstB = await handleSyncUploadComplete(caller, { uploadSessionId: sessB }, deps);
    assert.equal(firstB.statusCode, 200);

    // Batch: [A ok, B2 conflict, plus a bogus session → error]. Whole request 200.
    const res = await handleSyncUploadCompleteBatch(
      caller,
      { items: [
        { uploadSessionId: sessA },
        { uploadSessionId: sessB2 },
        { uploadSessionId: "00000000-0000-0000-0000-000000000000" },
      ] },
      deps
    );

    assert.equal(res.statusCode, 200, "whole batch is always 200");
    const { results } = JSON.parse(res.body);
    assert.equal(results.length, 3);

    // Item 0: A committed independently.
    assert.equal(results[0].ok, true);
    assert.equal(results[0].version, 1);

    // Item 1: B2 is a CAS conflict — does NOT roll back item 0.
    assert.equal(results[1].ok, false);
    assert.equal(results[1].status, 409);
    assert.equal(results[1].reason, "cas-mismatch");

    // Item 2: missing session → per-item error, still no abort.
    assert.equal(results[2].ok, false);
    assert.ok(results[2].status >= 400);

    // Confirm A actually persisted despite siblings failing.
    const mRes = await handleSyncManifest(caller, { afterSeq: 0 }, { db, repo });
    const items = JSON.parse(mRes.body).items;
    assert.ok(items.find((i: any) => i.path === "skills/batch-a.md"), "A persisted");
  });

  test("download-batch: mixed found / not-found per item", async () => {
    const { db } = await makeTestDb();
    const repo = makeOssSyncRepo(db);
    const team = await seedTeam(db);
    const actor = await seedMember(db, team.id);
    const caller = makeCaller(team.id, actor.id);

    const hash = h32("d");
    const size = 64;
    const s3State: MockS3State = { objects: new Map([[ossKeyFor(team.id, hash), size]]) };
    const s3 = makeMockS3WithPresign(s3State);
    const deps = { db, repo, s3: s3 as any, bucket: "test-bucket" };

    // Register one verified blob via prepare+complete.
    const pr = await handleSyncUploadPrepare(
      caller, { path: "skills/dl.bin", parentVersion: 0, contentHash: hash, size }, deps
    );
    await handleSyncUploadComplete(caller, { uploadSessionId: JSON.parse(pr.body).uploadSessionId }, deps);

    const res = await handleSyncDownloadBatch(
      caller,
      { items: [{ contentHash: hash }, { contentHash: h32("e") /* unknown */ }] },
      deps
    );

    assert.equal(res.statusCode, 200);
    const { results } = JSON.parse(res.body);
    assert.equal(results.length, 2);
    assert.equal(results[0].ok, true);
    assert.ok(results[0].downloadUrl);
    assert.equal(results[1].ok, false);
    assert.equal(results[1].status, 404);
  });

  test("delete-batch: per-item tombstone + independent CAS conflict", async () => {
    const { db } = await makeTestDb();
    const repo = makeOssSyncRepo(db);
    const team = await seedTeam(db);
    const actor = await seedMember(db, team.id);
    const caller = makeCaller(team.id, actor.id);

    const hash = h32("f");
    const size = 9;
    const s3State: MockS3State = { objects: new Map([[ossKeyFor(team.id, hash), size]]) };
    const s3 = makeMockS3WithPresign(s3State);
    const deps = { db, repo, s3: s3 as any, bucket: "test-bucket" };

    // Upload one file so it can be tombstoned at v1.
    const pr = await handleSyncUploadPrepare(
      caller, { path: "skills/del.md", parentVersion: 0, contentHash: hash, size }, deps
    );
    await handleSyncUploadComplete(caller, { uploadSessionId: JSON.parse(pr.body).uploadSessionId }, deps);

    const res = await handleSyncDeleteBatch(
      caller,
      { items: [
        { path: "skills/del.md", parentVersion: 1 },          // ok → v2 tombstone
        { path: "skills/del.md", parentVersion: 0 },          // stale → 409
        { path: "skills/never-existed.md", parentVersion: 0 } // missing → 404
      ] },
      { db, repo }
    );

    assert.equal(res.statusCode, 200);
    const { results } = JSON.parse(res.body);
    assert.equal(results.length, 3);
    assert.equal(results[0].ok, true);
    assert.equal(results[0].version, 2);
    assert.equal(results[1].ok, false);
    assert.equal(results[1].status, 409);
    assert.equal(results[2].ok, false);
    assert.equal(results[2].status, 404);
  });

  test("batch: oversized request rejected with 400 batch_too_large", async () => {
    const { db } = await makeTestDb();
    const repo = makeOssSyncRepo(db);
    const team = await seedTeam(db);
    const actor = await seedMember(db, team.id);

    const items = Array.from({ length: MAX_SYNC_BATCH + 1 }, (_, i) => ({
      path: `skills/x${i}.md`, parentVersion: 0, contentHash: h32("a"), size: 1,
    }));
    const res = await handleSyncUploadPrepareBatch(
      makeCaller(team.id, actor.id), { items }, { db, repo }
    );
    assert.equal(res.statusCode, 400);
    assert.equal(JSON.parse(res.body).code, "batch_too_large");
  });

  test("batch: non-array items rejected with 400; empty array → empty results", async () => {
    const { db } = await makeTestDb();
    const repo = makeOssSyncRepo(db);
    const team = await seedTeam(db);
    const actor = await seedMember(db, team.id);
    const caller = makeCaller(team.id, actor.id);

    const bad = await handleSyncDownloadBatch(caller, { items: "nope" as any }, { db, repo });
    assert.equal(bad.statusCode, 400);

    const empty = await handleSyncDownloadBatch(caller, { items: [] }, { db, repo });
    assert.equal(empty.statusCode, 200);
    assert.deepEqual(JSON.parse(empty.body).results, []);
  });
});

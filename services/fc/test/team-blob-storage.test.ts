import test from "node:test";
import assert from "node:assert/strict";

import { blobBackendKind, isMissingObject, s3BlobStorage } from "../src/lib/team-blob-storage.js";

function withEnv(value: string | undefined, fn: () => void) {
  const prev = process.env.TEAM_BLOBS_BACKEND;
  if (value === undefined) delete process.env.TEAM_BLOBS_BACKEND;
  else process.env.TEAM_BLOBS_BACKEND = value;
  try {
    fn();
  } finally {
    if (prev === undefined) delete process.env.TEAM_BLOBS_BACKEND;
    else process.env.TEAM_BLOBS_BACKEND = prev;
  }
}

test("blob backend defaults to supabase", () => {
  // Existing deployments must not relocate their blobs by upgrading.
  withEnv(undefined, () => assert.equal(blobBackendKind(), "supabase"));
  withEnv("", () => assert.equal(blobBackendKind(), "supabase"));
});

test("blob backend switches only on an explicit s3 opt-in", () => {
  withEnv("s3", () => assert.equal(blobBackendKind(), "s3"));
  withEnv(" s3 ", () => assert.equal(blobBackendKind(), "s3"));
  // Anything else is not a silent fallthrough to s3 — a typo must keep the
  // deployment where its bytes already are.
  withEnv("minio", () => assert.equal(blobBackendKind(), "supabase"));
  withEnv("S3", () => assert.equal(blobBackendKind(), "supabase"));
});

test("a missing object is classified apart from a real failure", () => {
  // "Missing" is the normal needs-upload answer. Swallowing other failures
  // would report every blob as absent and re-upload the whole team.
  assert.equal(isMissingObject({ $metadata: { httpStatusCode: 404 } }), true);
  assert.equal(isMissingObject({ name: "NotFound" }), true);
  assert.equal(isMissingObject({ name: "NoSuchKey" }), true);

  assert.equal(isMissingObject({ name: "AccessDenied", $metadata: { httpStatusCode: 403 } }), false);
  assert.equal(isMissingObject({ $metadata: { httpStatusCode: 500 } }), false);
  assert.equal(isMissingObject(new Error("socket hang up")), false);
  assert.equal(isMissingObject(undefined), false);
});

test("the shared bucket is partitioned by key prefix", async () => {
  // Knowledge blobs and skill packages are content-addressed the same way, so
  // their object paths are byte-identical. Without the prefix they would be the
  // same object in a shared bucket, and one side's GC would delete the other's.
  const seen: string[] = [];
  const original = process.env.ACCESS_KEY_ID;
  process.env.ACCESS_KEY_ID = "k";
  process.env.ACCESS_KEY_SECRET = "s";
  process.env.ENDPOINT = "https://s3.example.com";

  const objectPath = "teams/t1/blobs/sha256/aa/bb/hash";
  for (const prefix of ["team-blobs", "team-skills", "", "/team-blobs/"]) {
    const url = await s3BlobStorage(
      () => "shared",
      () => prefix,
    ).createUploadUrl(objectPath);
    // Path-style puts the bucket in the path, virtual-host style in the
    // hostname. Normalize so this test pins the prefix, not the addressing mode
    // (MinIO needs path-style, OSS does not — both must partition the same).
    seen.push(new URL(url).pathname.replace(/^\/shared/, ""));
  }
  if (original === undefined) delete process.env.ACCESS_KEY_ID;
  else process.env.ACCESS_KEY_ID = original;

  assert.equal(seen[0], `/team-blobs/${objectPath}`);
  assert.equal(seen[1], `/team-skills/${objectPath}`);
  // No prefix is legitimate: app bundles carry their own `apps/` already.
  assert.equal(seen[2], `/${objectPath}`);
  // Stray slashes must not produce `//` or a leading empty segment.
  assert.equal(seen[3], seen[0]);
});

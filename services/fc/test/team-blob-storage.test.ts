import test from "node:test";
import assert from "node:assert/strict";

import { blobBackendKind, isMissingObject } from "../src/lib/team-blob-storage.js";

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

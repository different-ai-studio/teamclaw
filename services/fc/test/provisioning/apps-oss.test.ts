/**
 * The apps artifact profile decides where `apps/<appId>/code.zip` is presigned
 * to and which credentials sign it. Getting it wrong is invisible until a real
 * deploy: the upload 403s, or Function Compute reports a code location it
 * cannot read. These tests pin the two shapes apart — one Alibaba account for
 * everything (the FC target), and a self-host box whose default S3 config is a
 * local MinIO that must never be borrowed for app code.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveAppsOss, appsRegion } from "../../src/lib/provisioning/apps-oss.js";

/** The Alibaba FC target: one account, no APPS_* overrides. */
const SHARED_ENV = {
  ACCESS_KEY_ID: "LTAI-shared",
  ACCESS_KEY_SECRET: "shared-secret",
  BUCKET: "teamclu-sync",
  REGION: "cn-shenzhen",
  ENDPOINT: "https://oss-cn-shenzhen.aliyuncs.com",
} as NodeJS.ProcessEnv;

/** The self-host box as it actually stands: ACCESS_KEY_* are MinIO's. */
const SELF_HOST_ENV = {
  ACCESS_KEY_ID: "minioadmin",
  ACCESS_KEY_SECRET: "minio-secret",
  BUCKET: "teamclu-team",
  REGION: "cn-shenzhen",
  ENDPOINT: "https://s3.teamclu-dev.ucar.cc",
  S3_FORCE_PATH_STYLE: "1",
} as NodeJS.ProcessEnv;

test("no APPS_* overrides keeps the deployment's own S3 config", () => {
  const r = resolveAppsOss(SHARED_ENV);
  assert.equal(r.error, undefined);
  assert.deepEqual(r.profile, {
    bucket: "teamclu-sync",
    region: "cn-shenzhen",
    endpoint: "https://oss-cn-shenzhen.aliyuncs.com",
    accessKeyId: "LTAI-shared",
    accessKeySecret: "shared-secret",
    forcePathStyle: false,
  });
});

test("a bucket override alone stays on the shared account", () => {
  // Legitimate on the FC target: same credentials, app code in its own bucket.
  const r = resolveAppsOss({ ...SHARED_ENV, APPS_OSS_BUCKET: "teamclu-apps" });
  assert.equal(r.profile?.bucket, "teamclu-apps");
  assert.equal(r.profile?.accessKeyId, "LTAI-shared");
});

test("a dedicated profile does not inherit the MinIO endpoint or path style", () => {
  // The whole point: self-host's ENDPOINT/S3_FORCE_PATH_STYLE describe MinIO.
  // Inheriting either would presign app code into the box's own bucket, which
  // Function Compute cannot read.
  const r = resolveAppsOss({
    ...SELF_HOST_ENV,
    APPS_ACCESS_KEY_ID: "LTAI-apps",
    APPS_ACCESS_KEY_SECRET: "apps-secret",
    APPS_OSS_BUCKET: "teamclu-apps",
    APPS_REGION: "cn-hangzhou",
  });
  assert.equal(r.error, undefined);
  assert.deepEqual(r.profile, {
    bucket: "teamclu-apps",
    region: "cn-hangzhou",
    endpoint: "https://oss-cn-hangzhou.aliyuncs.com",
    accessKeyId: "LTAI-apps",
    accessKeySecret: "apps-secret",
    forcePathStyle: false,
  });
});

test("a dedicated profile can point at an explicit (e.g. VPC) OSS endpoint", () => {
  const r = resolveAppsOss({
    ...SELF_HOST_ENV,
    APPS_ACCESS_KEY_ID: "LTAI-apps",
    APPS_ACCESS_KEY_SECRET: "apps-secret",
    APPS_OSS_BUCKET: "teamclu-apps",
    APPS_REGION: "cn-hangzhou",
    APPS_OSS_ENDPOINT: "https://oss-cn-hangzhou-internal.aliyuncs.com",
  });
  assert.equal(r.profile?.endpoint, "https://oss-cn-hangzhou-internal.aliyuncs.com");
});

test("dedicated credentials without a bucket are refused, by name", () => {
  // Falling back to BUCKET here would sign an Alibaba request for the MinIO
  // bucket name and fail at upload time with NoSuchBucket.
  const r = resolveAppsOss({
    ...SELF_HOST_ENV,
    APPS_ACCESS_KEY_ID: "LTAI-apps",
    APPS_ACCESS_KEY_SECRET: "apps-secret",
  });
  assert.equal(r.profile, undefined);
  assert.match(r.error!, /APPS_OSS_BUCKET/);
});

test("a dedicated key without its secret is refused, by name", () => {
  const r = resolveAppsOss({
    ...SELF_HOST_ENV,
    APPS_ACCESS_KEY_ID: "LTAI-apps",
    APPS_OSS_BUCKET: "teamclu-apps",
  });
  assert.equal(r.profile, undefined);
  assert.match(r.error!, /APPS_ACCESS_KEY_SECRET/);
});

test("a region override with no dedicated profile is refused", () => {
  // ENDPOINT still names the old region, so FC would get a cross-region code
  // location — a failure that surfaces inside the FC API, far from the cause.
  const r = resolveAppsOss({ ...SHARED_ENV, APPS_REGION: "cn-hangzhou" });
  assert.equal(r.profile, undefined);
  assert.match(r.error!, /APPS_REGION/);
});

test("no credentials at all is a named failure, not a crash", () => {
  const r = resolveAppsOss({ BUCKET: "b" } as NodeJS.ProcessEnv);
  assert.equal(r.profile, undefined);
  assert.match(r.error!, /ACCESS_KEY_ID/);
});

test("appsRegion prefers APPS_REGION and falls back to REGION", () => {
  assert.equal(appsRegion({ REGION: "cn-shenzhen" } as NodeJS.ProcessEnv), "cn-shenzhen");
  assert.equal(
    appsRegion({ REGION: "cn-shenzhen", APPS_REGION: "cn-hangzhou" } as NodeJS.ProcessEnv),
    "cn-hangzhou",
  );
  assert.equal(appsRegion({} as NodeJS.ProcessEnv), "cn-hangzhou");
});

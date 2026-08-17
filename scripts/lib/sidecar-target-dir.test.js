const assert = require("node:assert/strict");
const { test } = require("node:test");
const path = require("node:path");

const { sidecarTargetDir } = require("./sidecar-target-dir");

test("sidecar builds get their own directory under CARGO_TARGET_DIR", () => {
  const dir = sidecarTargetDir(
    { CARGO_TARGET_DIR: "/tmp/shared-target" },
    "/repo/apps/desktop",
    "amuxd",
  );
  assert.equal(dir, path.join("/tmp/shared-target", "sidecar-amuxd"));
});

test("each sidecar gets a distinct directory", () => {
  const env = { CARGO_TARGET_DIR: "/tmp/shared-target" };
  assert.notEqual(
    sidecarTargetDir(env, "/repo/apps/desktop", "amuxd"),
    sidecarTargetDir(env, "/repo/apps/desktop", "teamclu-introspect"),
  );
});

test("never returns the shared target dir itself", () => {
  const shared = "/tmp/shared-target";
  const dir = sidecarTargetDir({ CARGO_TARGET_DIR: shared }, "/repo/apps/desktop", "amuxd");
  assert.notEqual(dir, shared);
  assert.equal(path.dirname(dir), shared);
});

test("falls back to <dir>/target when CARGO_TARGET_DIR is unset", () => {
  const dir = sidecarTargetDir({}, "/repo/apps/desktop", "amuxd");
  assert.equal(dir, path.join("/repo/apps/desktop", "target", "sidecar-amuxd"));
});

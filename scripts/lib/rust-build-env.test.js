const assert = require("node:assert/strict");
const { test } = require("node:test");
const path = require("node:path");

const { createRustBuildEnv } = require("../rust-build-env");

const SCRIPT_DIR = path.join(__dirname, "..");

// RUSTC_WRAPPER is passed in explicitly so these do not depend on whether the
// machine running the suite happens to have sccache on PATH.
const withSccache = (extra = {}) => ({ RUSTC_WRAPPER: "sccache", ...extra });

test("routes sccache over a unix socket instead of TCP", () => {
  const env = createRustBuildEnv(withSccache(), SCRIPT_DIR);
  assert.match(env.SCCACHE_SERVER_UDS, /^\/tmp\/sccache-\d+\.sock$/);
});

test("the socket path fits macOS sun_path (104 bytes)", () => {
  const env = createRustBuildEnv(withSccache(), SCRIPT_DIR);
  assert.ok(
    Buffer.byteLength(env.SCCACHE_SERVER_UDS) < 104,
    `socket path too long: ${env.SCCACHE_SERVER_UDS}`,
  );
});

test("an explicit SCCACHE_SERVER_UDS wins", () => {
  const env = createRustBuildEnv(
    withSccache({ SCCACHE_SERVER_UDS: "/tmp/mine.sock" }),
    SCRIPT_DIR,
  );
  assert.equal(env.SCCACHE_SERVER_UDS, "/tmp/mine.sock");
});

test("CI keeps its own sccache transport", () => {
  const env = createRustBuildEnv(withSccache({ CI: "true" }), SCRIPT_DIR);
  assert.equal(env.SCCACHE_SERVER_UDS, undefined);
});

test("a non-sccache wrapper is left alone", () => {
  const env = createRustBuildEnv({ RUSTC_WRAPPER: "some-other-wrapper" }, SCRIPT_DIR);
  assert.equal(env.SCCACHE_SERVER_UDS, undefined);
});

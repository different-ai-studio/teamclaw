const assert = require("node:assert/strict");
const { test } = require("node:test");

const { applyDevSkipFlags } = require("./dev-flags");

const silent = { log: () => {} };

test("dev forces an amuxd sidecar rebuild by default", () => {
  const env = {};
  const argv = applyDevSkipFlags(["dev"], env, silent);
  assert.deepEqual(argv, ["dev"]);
  assert.equal(env.TEAMCLU_FORCE_AMUXD_SIDECAR, "1");
});

test("--no-force-amuxd opts out and is stripped from argv", () => {
  const env = {};
  const argv = applyDevSkipFlags(["dev", "--no-force-amuxd"], env, silent);
  assert.deepEqual(argv, ["dev"]);
  assert.equal(env.TEAMCLU_FORCE_AMUXD_SIDECAR, "0");
});

test("--skip-amuxd and --no-rebuild-amuxd alias --no-force-amuxd", () => {
  for (const flag of ["--skip-amuxd", "--no-rebuild-amuxd"]) {
    const env = {};
    assert.deepEqual(applyDevSkipFlags(["dev", flag], env, silent), ["dev"]);
    assert.equal(env.TEAMCLU_FORCE_AMUXD_SIDECAR, "0", flag);
  }
});

test("an explicit opt-out beats an inherited TEAMCLU_FORCE_AMUXD_SIDECAR=1", () => {
  const env = { TEAMCLU_FORCE_AMUXD_SIDECAR: "1" };
  applyDevSkipFlags(["dev", "--no-force-amuxd"], env, silent);
  assert.equal(env.TEAMCLU_FORCE_AMUXD_SIDECAR, "0");
});

test("TEAMCLU_FORCE_AMUXD_SIDECAR=0 opts out without a flag", () => {
  const env = { TEAMCLU_FORCE_AMUXD_SIDECAR: "0" };
  applyDevSkipFlags(["dev"], env, silent);
  assert.equal(env.TEAMCLU_FORCE_AMUXD_SIDECAR, "0");
});

test("non-dev subcommands are left entirely alone", () => {
  const env = {};
  const argv = applyDevSkipFlags(["build", "--debug"], env, silent);
  assert.deepEqual(argv, ["build", "--debug"]);
  assert.equal(env.TEAMCLU_FORCE_AMUXD_SIDECAR, undefined);
});

test("other dev flags still parse alongside the amuxd default", () => {
  const env = {};
  const argv = applyDevSkipFlags(
    ["dev", "--skip-setup", "--skip-onboarding", "--force-introspect", "--"],
    env,
    silent,
  );
  assert.deepEqual(argv, ["dev", "--"]);
  assert.equal(env.VITE_TEAMCLU_SKIP_SETUP, "true");
  assert.equal(env.VITE_TEAMCLU_SKIP_DAEMON_ONBOARDING, "true");
  assert.equal(env.TEAMCLU_FORCE_INTROSPECT_SIDECAR, "1");
  assert.equal(env.TEAMCLU_FORCE_AMUXD_SIDECAR, "1");
});

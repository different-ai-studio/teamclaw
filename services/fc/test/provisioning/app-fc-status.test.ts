import { test } from "node:test";
import assert from "node:assert/strict";
import { isLegalFcTransition } from "../../src/lib/provisioning/app-fc-status.js";

test("deploy happy path transitions are legal", () => {
  assert.ok(isLegalFcTransition("not_deployed", "awaiting_build"));
  assert.ok(isLegalFcTransition("awaiting_build", "building"));
  assert.ok(isLegalFcTransition("building", "deploying"));
  assert.ok(isLegalFcTransition("deploying", "live"));
});
test("retry from terminal states is legal", () => {
  assert.ok(isLegalFcTransition("live", "awaiting_build"));
  assert.ok(isLegalFcTransition("deploy_error", "awaiting_build"));
});
test("any state may move to deploy_error", () => {
  for (const s of ["awaiting_build", "building", "deploying"]) {
    assert.ok(isLegalFcTransition(s, "deploy_error"), s);
  }
});
test("illegal jumps are rejected", () => {
  assert.equal(isLegalFcTransition("not_deployed", "live"), false);
  assert.equal(isLegalFcTransition("not_deployed", "deploying"), false);
});
test("null/undefined current state is treated as not_deployed", () => {
  assert.ok(isLegalFcTransition(null, "awaiting_build"));
});

import test from "node:test";
import assert from "node:assert/strict";
import { genTeamSecret } from "../harness/secret.mjs";

test("genTeamSecret returns 64 lowercase hex chars (32 bytes)", () => {
  const s = genTeamSecret();
  assert.match(s, /^[0-9a-f]{64}$/);
});

test("genTeamSecret is random across calls", () => {
  assert.notEqual(genTeamSecret(), genTeamSecret());
});

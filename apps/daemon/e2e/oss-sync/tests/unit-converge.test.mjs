import test from "node:test";
import assert from "node:assert/strict";
import { isSidecar, splitTree, assertConverged } from "../harness/converge.mjs";

test("isSidecar matches *.conflict.* names", () => {
  assert.equal(isSidecar("skills/x.conflict.1748332800.abc123de.md"), true);
  assert.equal(isSidecar("skills/x.md"), false);
});

test("splitTree separates regular vs sidecar", () => {
  const tree = {
    "skills/x.md": "AA",
    "skills/x.conflict.1.deadbeef.md": "BB",
  };
  const { regular, sidecars } = splitTree(tree);
  assert.deepEqual(Object.keys(regular), ["skills/x.md"]);
  assert.deepEqual(Object.keys(sidecars), ["skills/x.conflict.1.deadbeef.md"]);
});

test("assertConverged passes when regular files match (sidecars ignored)", () => {
  const a = { "a.md": "1", "a.conflict.1.aaaaaaaa.md": "x" };
  const b = { "a.md": "1" };
  assert.doesNotThrow(() => assertConverged(a, b));
});

test("assertConverged throws when regular files differ", () => {
  assert.throws(() => assertConverged({ "a.md": "1" }, { "a.md": "2" }));
  assert.throws(() => assertConverged({ "a.md": "1" }, {}));
});

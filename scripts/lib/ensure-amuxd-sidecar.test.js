const assert = require("node:assert/strict");
const { test } = require("node:test");

const {
  shouldRebuildSidecar,
} = require("../ensure-amuxd-sidecar");

test("rebuilds bundled amuxd sidecar when installed sidecar version is older", () => {
  assert.equal(
    shouldRebuildSidecar({
      expectedVersion: "0.2.16",
      existingVersion: "0.2.10",
      exists: true,
    }),
    true,
  );
});

test("keeps bundled amuxd sidecar when version matches", () => {
  assert.equal(
    shouldRebuildSidecar({
      expectedVersion: "0.2.16",
      existingVersion: "0.2.16",
      exists: true,
    }),
    false,
  );
});

test("builds bundled amuxd sidecar when file is missing", () => {
  assert.equal(
    shouldRebuildSidecar({
      expectedVersion: "0.2.16",
      existingVersion: null,
      exists: false,
    }),
    true,
  );
});

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");

const {
  bridgeFingerprint,
  shouldRebuildBundle,
} = require("../ensure-agent-bridge-bundles");

test("shouldRebuildBundle when stamp or tree is missing", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-bundle-"));
  try {
    assert.equal(
      shouldRebuildBundle({ destDir: dir, fingerprint: "abc", force: false }),
      true,
    );
    fs.mkdirSync(path.join(dir, "src"));
    fs.writeFileSync(path.join(dir, "src", "main.mjs"), "//");
    fs.mkdirSync(path.join(dir, "node_modules"));
    fs.writeFileSync(path.join(dir, ".bundle-fingerprint"), "abc\n");
    assert.equal(
      shouldRebuildBundle({ destDir: dir, fingerprint: "abc", force: false }),
      false,
    );
    assert.equal(
      shouldRebuildBundle({ destDir: dir, fingerprint: "def", force: false }),
      true,
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("bridgeFingerprint tracks package + lock", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-fp-"));
  try {
    fs.writeFileSync(path.join(dir, "package.json"), '{"name":"x"}');
    fs.writeFileSync(path.join(dir, "package-lock.json"), '{"lockfileVersion":3}');
    const first = bridgeFingerprint(dir);
    assert.ok(first);
    fs.appendFileSync(path.join(dir, "package-lock.json"), "\n");
    assert.notEqual(bridgeFingerprint(dir), first);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

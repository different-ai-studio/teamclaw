const assert = require("node:assert/strict");
const { test } = require("node:test");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {
  shouldRebuildSidecar,
  installSidecarAtomic,
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

test("installSidecarAtomic replaces dest with a new inode", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sidecar-atomic-"));
  try {
    const built = path.join(dir, "built");
    const dest = path.join(dir, "dest");
    fs.writeFileSync(built, "v1");
    fs.writeFileSync(dest, "old");
    const oldIno = fs.statSync(dest).ino;
    installSidecarAtomic(built, dest);
    assert.equal(fs.readFileSync(dest, "utf8"), "v1");
    assert.notEqual(fs.statSync(dest).ino, oldIno);
    assert.equal(fs.existsSync(`${dest}.tmp.${process.pid}`), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

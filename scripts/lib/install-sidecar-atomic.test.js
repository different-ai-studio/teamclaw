const assert = require("node:assert/strict");
const { test } = require("node:test");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {
  installSidecarAtomic,
  installSidecarIfChanged,
} = require("./install-sidecar-atomic");

function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "sidecar-install-"));
}

test("installSidecarAtomic replaces dest with a new inode", () => {
  const dir = tmpdir();
  try {
    const built = path.join(dir, "built");
    const dest = path.join(dir, "dest");
    fs.writeFileSync(built, "v1");
    fs.writeFileSync(dest, "old");
    const oldIno = fs.statSync(dest).ino;
    installSidecarAtomic(built, dest);
    assert.equal(fs.readFileSync(dest, "utf8"), "v1");
    assert.notEqual(fs.statSync(dest).ino, oldIno);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("identical bytes are not restaged, so mtime survives", () => {
  const dir = tmpdir();
  try {
    const built = path.join(dir, "built");
    const dest = path.join(dir, "dest");
    fs.writeFileSync(built, "same");
    fs.writeFileSync(dest, "same");
    const before = fs.statSync(dest);
    assert.equal(installSidecarIfChanged(built, dest), false);
    const after = fs.statSync(dest);
    assert.equal(after.ino, before.ino);
    assert.equal(after.mtimeMs, before.mtimeMs);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("differing bytes of the same size are still restaged", () => {
  const dir = tmpdir();
  try {
    const built = path.join(dir, "built");
    const dest = path.join(dir, "dest");
    fs.writeFileSync(built, "aaaa");
    fs.writeFileSync(dest, "bbbb"); // same size — a size check alone would miss this
    assert.equal(installSidecarIfChanged(built, dest), true);
    assert.equal(fs.readFileSync(dest, "utf8"), "aaaa");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a missing dest is installed", () => {
  const dir = tmpdir();
  try {
    const built = path.join(dir, "built");
    const dest = path.join(dir, "nested", "dest");
    fs.writeFileSync(built, "v1");
    assert.equal(installSidecarIfChanged(built, dest), true);
    assert.equal(fs.readFileSync(dest, "utf8"), "v1");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("hashing handles files larger than one read chunk", () => {
  const dir = tmpdir();
  try {
    const built = path.join(dir, "built");
    const dest = path.join(dir, "dest");
    // 9MB > the 8MB chunk, and the two differ only past the first chunk.
    const base = Buffer.alloc(9 * 1024 * 1024, 0x41);
    const other = Buffer.from(base);
    other[8 * 1024 * 1024 + 7] = 0x42;
    fs.writeFileSync(built, base);
    fs.writeFileSync(dest, other);
    assert.equal(installSidecarIfChanged(built, dest), true);
    assert.equal(installSidecarIfChanged(built, dest), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

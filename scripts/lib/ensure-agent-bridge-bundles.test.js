const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");

const {
  bridgeFingerprint,
  bundleStamp,
  extractTargetFromArgv,
  parseCliArgs,
  resolveNpmPlatform,
  rustTargetToNpmPlatform,
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

test("rustTargetToNpmPlatform maps release matrix triples", () => {
  assert.deepEqual(rustTargetToNpmPlatform("aarch64-apple-darwin"), {
    os: "darwin",
    cpu: "arm64",
  });
  assert.deepEqual(rustTargetToNpmPlatform("x86_64-apple-darwin"), {
    os: "darwin",
    cpu: "x64",
  });
  assert.deepEqual(rustTargetToNpmPlatform("x86_64-pc-windows-msvc"), {
    os: "win32",
    cpu: "x64",
  });
  assert.throws(() => rustTargetToNpmPlatform("wasm32-unknown-unknown"), /unsupported/);
});

test("bundleStamp includes npm platform so cross-target rebuilds", () => {
  const arm = bundleStamp("abc", { os: "darwin", cpu: "arm64" });
  const x64 = bundleStamp("abc", { os: "darwin", cpu: "x64" });
  assert.equal(arm, "abc:darwin-arm64");
  assert.equal(x64, "abc:darwin-x64");
  assert.notEqual(arm, x64);
});

test("resolveNpmPlatform uses host when target omitted", () => {
  const host = resolveNpmPlatform(null);
  assert.ok(host.os);
  assert.ok(host.cpu);
  assert.deepEqual(resolveNpmPlatform("x86_64-apple-darwin"), {
    os: "darwin",
    cpu: "x64",
  });
});

test("parseCliArgs and extractTargetFromArgv", () => {
  assert.deepEqual(parseCliArgs(["--force", "--target", "x86_64-apple-darwin"]), {
    force: true,
    target: "x86_64-apple-darwin",
  });
  assert.deepEqual(parseCliArgs(["--target=aarch64-apple-darwin"]), {
    force: false,
    target: "aarch64-apple-darwin",
  });
  assert.equal(
    extractTargetFromArgv(["build", "--target", "x86_64-apple-darwin"]),
    "x86_64-apple-darwin",
  );
  assert.equal(
    extractTargetFromArgv(["build", "--target=aarch64-apple-darwin", "--debug"]),
    "aarch64-apple-darwin",
  );
  assert.equal(extractTargetFromArgv(["dev"]), null);
});

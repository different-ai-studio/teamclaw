"use strict";
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const {
  parseExtensionsConfig,
  resolveExtensionPack,
  domainsToChromeMatchPatterns,
  SIDE_PANEL_PRUNE_DIRS,
  PRUNE_REFERENCE_EXCEPTIONS,
} = require("./extension-config");

test("resolveExtensionPack reads the repo's extensions.domains spelling", () => {
  const pack = resolveExtensionPack({ extensions: { domains: ["*.example.com"] } });
  assert.deepStrictEqual(pack.domains, ["*.example.com"]);
});

// Regression: every brand in the enterprise-branding repo declares
// `extension.hosts`, which parsed to nothing under the old `extensions.domains`
// -only reader. The manifest then kept its <all_urls> default, so brands that
// meant to scope to a handful of domains shipped full host access to review.
test("resolveExtensionPack reads the branding repo's extension.hosts spelling", () => {
  const pack = resolveExtensionPack({
    extension: { hosts: ["https://*.shopee.io/*", "https://*.seamoney.io/*"] },
  });
  assert.deepStrictEqual(pack.domains, ["*.shopee.io", "*.seamoney.io"]);
  assert.deepStrictEqual(domainsToChromeMatchPatterns(pack.domains), [
    "https://*.shopee.io/*",
    "https://*.seamoney.io/*",
  ]);
});

test("resolveExtensionPack unions both spellings and dedupes", () => {
  const pack = resolveExtensionPack({
    extensions: { domains: ["*.example.com"] },
    extension: { hosts: ["https://*.example.com/*", "https://*.other.com/*"] },
  });
  assert.deepStrictEqual(pack.domains, ["*.example.com", "*.other.com"]);
});

test("resolveExtensionPack yields no domains when neither block is present", () => {
  const pack = resolveExtensionPack({ app: { name: "TeamClaw" } });
  assert.deepStrictEqual(pack.domains, []);
  assert.strictEqual(pack.solo, false);
});

test("resolveExtensionPack tolerates a missing or non-object config", () => {
  for (const input of [undefined, null, "nope", 42]) {
    assert.deepStrictEqual(resolveExtensionPack(input).domains, []);
  }
});

test("resolveExtensionPack honours solo from either block", () => {
  assert.strictEqual(resolveExtensionPack({ extensions: { solo: true } }).solo, true);
  assert.strictEqual(resolveExtensionPack({ extension: { solo: true } }).solo, true);
  assert.strictEqual(resolveExtensionPack({ extension: { solo: false } }).solo, false);
});

test("resolveExtensionPack lets the canonical block win on settings", () => {
  const pack = resolveExtensionPack({
    extension: { settings: { hideButton: true } },
    extensions: { settings: { hideButton: false, linkHover: { domains: ["a.com"] } } },
  });
  assert.strictEqual(pack.settings.hideButton, false);
  assert.deepStrictEqual(pack.settings.linkHover.domains, ["a.com"]);
});

test("parseExtensionsConfig still accepts a bare domains row", () => {
  const pack = parseExtensionsConfig({ domains: ["https://*.a.com/*", "*.a.com"] });
  assert.deepStrictEqual(pack.domains, ["*.a.com"]);
});

// --- side-panel prune list -------------------------------------------------
// Pruning an asset the side panel actually requests is invisible at build time
// and shows up as a broken image in a published extension. These two tests are
// the reason the list can be trusted: one proves each entry exists to be
// pruned, the other proves nothing references it.

const repoRoot = path.resolve(__dirname, "../..");
const publicDir = path.join(repoRoot, "packages/app/public");
const srcDir = path.join(repoRoot, "packages/app/src");

function walk(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full));
    else out.push(full);
  }
  return out;
}

test("every pruned directory actually exists under packages/app/public", () => {
  for (const dir of SIDE_PANEL_PRUNE_DIRS) {
    assert.ok(
      fs.existsSync(path.join(publicDir, dir)),
      `${dir} is on the prune list but not in packages/app/public — stale entry, drop it`
    );
  }
});

test("no pruned directory is referenced from live packages/app/src code", () => {
  const sources = walk(srcDir).filter((f) => /\.(ts|tsx|js|jsx|css|html)$/.test(f));
  const excused = new Set(PRUNE_REFERENCE_EXCEPTIONS.map((e) => path.join(repoRoot, e.file)));
  for (const dir of SIDE_PANEL_PRUNE_DIRS) {
    const offenders = sources
      .filter((file) => !excused.has(file))
      .filter((file) => fs.readFileSync(file, "utf8").includes(`/${dir}/`));
    assert.deepStrictEqual(
      offenders.map((f) => path.relative(repoRoot, f)),
      [],
      `packages/app/public/${dir}/ is on the extension prune list but is referenced above — ` +
        `pruning it would ship a broken asset. Either stop referencing it, add a documented ` +
        `entry to PRUNE_REFERENCE_EXCEPTIONS, or drop it from SIDE_PANEL_PRUNE_DIRS.`
    );
  }
});

test("every prune exception is genuinely dead — its export is never imported", () => {
  const sources = walk(srcDir).filter((f) => /\.(ts|tsx|js|jsx)$/.test(f));
  for (const exception of PRUNE_REFERENCE_EXCEPTIONS) {
    const self = path.join(repoRoot, exception.file);
    assert.ok(fs.existsSync(self), `${exception.file} no longer exists — drop the exception`);

    const importers = sources
      .filter((file) => file !== self)
      .filter((file) => {
        const text = fs.readFileSync(file, "utf8");
        // Any import naming the symbol, static or dynamic, in any brace layout.
        return new RegExp(`\\b${exception.symbol}\\b`).test(text);
      });

    assert.deepStrictEqual(
      importers.map((f) => path.relative(repoRoot, f)),
      [],
      `${exception.symbol} is now referenced by the files above, so ` +
        `packages/app/public/${exception.dir}/ is live and must not be pruned — ` +
        `remove "${exception.dir}" from SIDE_PANEL_PRUNE_DIRS.`
    );
  }
});

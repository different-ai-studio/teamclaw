"use strict";
const test = require("node:test");
const assert = require("node:assert");
const {
  parseExtensionsConfig,
  resolveExtensionPack,
  domainsToChromeMatchPatterns,
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

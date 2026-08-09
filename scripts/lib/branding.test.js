"use strict";
const test = require("node:test");
const assert = require("node:assert");
const { applyNameToTauriConf } = require("./branding");

test("applyNameToTauriConf sets productName and window title from app.name", () => {
  const conf = { productName: "TeamClu", app: { windows: [{ title: "TeamClu" }] } };
  const changed = applyNameToTauriConf(conf, { app: { name: "Acme" } });
  assert.strictEqual(changed, true);
  assert.strictEqual(conf.productName, "Acme");
  assert.strictEqual(conf.app.windows[0].title, "Acme");
});

test("applyNameToTauriConf is a no-op when app.name is absent", () => {
  const conf = { productName: "TeamClu", app: { windows: [{ title: "TeamClu" }] } };
  const changed = applyNameToTauriConf(conf, { app: {} });
  assert.strictEqual(changed, false);
  assert.strictEqual(conf.productName, "TeamClu");
});

test("applyNameToTauriConf tolerates missing windows array", () => {
  const conf = { productName: "TeamClu", app: {} };
  const changed = applyNameToTauriConf(conf, { app: { name: "Acme" } });
  assert.strictEqual(changed, true);
  assert.strictEqual(conf.productName, "Acme");
});

test("applyNameToTauriConf titles the window with displayName, keeping productName on app.name", () => {
  const conf = { productName: "OldName", app: { windows: [{ title: "OldName" }] } };
  const changed = applyNameToTauriConf(conf, { app: { name: "TeamClu", displayName: "TeamClu 龙虾团" } });
  assert.strictEqual(changed, true);
  assert.strictEqual(conf.productName, "TeamClu");
  assert.strictEqual(conf.app.windows[0].title, "TeamClu 龙虾团");
});

test("applyNameToTauriConf renames only the window when app.name is absent", () => {
  const conf = { productName: "TeamClu", app: { windows: [{ title: "TeamClu" }] } };
  const changed = applyNameToTauriConf(conf, { app: { displayName: "TeamClu 龙虾团" } });
  assert.strictEqual(changed, true);
  assert.strictEqual(conf.productName, "TeamClu");
  assert.strictEqual(conf.app.windows[0].title, "TeamClu 龙虾团");
});

const path = require("node:path");
const { resolveLogoPlan } = require("./branding");

test("resolveLogoPlan returns null when app.logo is absent", () => {
  assert.strictEqual(resolveLogoPlan({ app: {} }, "/repo"), null);
});

test("resolveLogoPlan builds absolute source + targets from app.logo", () => {
  const plan = resolveLogoPlan({ app: { logo: "branding/acme/logo.png" } }, "/repo");
  assert.strictEqual(plan.source, path.resolve("/repo", "branding/acme/logo.png"));
  assert.strictEqual(plan.iconsOutDir, path.join("/repo", "apps/desktop/icons"));
  assert.deepStrictEqual(plan.publicLogoTargets, [
    path.join("/repo", "packages/app/public/logo.png"),
    path.join("/repo", "packages/app/public/logo-64.png"),
  ]);
  assert.strictEqual(plan.generatedIcon, path.join("/repo", "apps/desktop/icons", "128x128.png"));
});

test("resolveLogoPlan honors an absolute logo path", () => {
  const plan = resolveLogoPlan({ app: { logo: "/abs/brand/logo.png" } }, "/repo");
  assert.strictEqual(plan.source, "/abs/brand/logo.png");
});

const { applyIdentityToTauriConf } = require("./branding");

function baseConf() {
  return {
    identifier: "com.teamclu.app",
    plugins: { "deep-link": { desktop: { schemes: ["teamclu"] } } },
  };
}

test("applyIdentityToTauriConf sets identifier and scheme when provided", () => {
  const conf = baseConf();
  const changed = applyIdentityToTauriConf(conf, { app: { identifier: "com.acme.app", scheme: "acme" } });
  assert.strictEqual(changed, true);
  assert.strictEqual(conf.identifier, "com.acme.app");
  assert.deepStrictEqual(conf.plugins["deep-link"].desktop.schemes, ["acme"]);
});

test("applyIdentityToTauriConf is a no-op when neither is provided", () => {
  const conf = baseConf();
  const changed = applyIdentityToTauriConf(conf, { app: {} });
  assert.strictEqual(changed, false);
  assert.strictEqual(conf.identifier, "com.teamclu.app");
  assert.deepStrictEqual(conf.plugins["deep-link"].desktop.schemes, ["teamclu"]);
});

test("applyIdentityToTauriConf sets only identifier when only identifier given", () => {
  const conf = baseConf();
  const changed = applyIdentityToTauriConf(conf, { app: { identifier: "com.acme.app" } });
  assert.strictEqual(changed, true);
  assert.strictEqual(conf.identifier, "com.acme.app");
  assert.deepStrictEqual(conf.plugins["deep-link"].desktop.schemes, ["teamclu"]);
});

test("applyIdentityToTauriConf throws on an invalid identifier (single segment)", () => {
  assert.throws(() => applyIdentityToTauriConf(baseConf(), { app: { identifier: "acme" } }), /identifier/i);
});

test("applyIdentityToTauriConf throws on an invalid identifier (underscore)", () => {
  assert.throws(() => applyIdentityToTauriConf(baseConf(), { app: { identifier: "com.ac_me.app" } }), /identifier/i);
});

test("applyIdentityToTauriConf throws on an invalid scheme (leading digit)", () => {
  assert.throws(() => applyIdentityToTauriConf(baseConf(), { app: { scheme: "1acme" } }), /scheme/i);
});

test("applyIdentityToTauriConf throws on an invalid scheme (space)", () => {
  assert.throws(() => applyIdentityToTauriConf(baseConf(), { app: { scheme: "ac me" } }), /scheme/i);
});

test("applyIdentityToTauriConf sets only scheme when only scheme given", () => {
  const conf = baseConf();
  const changed = applyIdentityToTauriConf(conf, { app: { scheme: "acme" } });
  assert.strictEqual(changed, true);
  assert.strictEqual(conf.identifier, "com.teamclu.app");
  assert.deepStrictEqual(conf.plugins["deep-link"].desktop.schemes, ["acme"]);
});

test("applyIdentityToTauriConf creates the deep-link path when missing", () => {
  const conf = { identifier: "com.teamclu.app" };
  const changed = applyIdentityToTauriConf(conf, { app: { scheme: "acme" } });
  assert.strictEqual(changed, true);
  assert.deepStrictEqual(conf.plugins["deep-link"].desktop.schemes, ["acme"]);
});

const { applyNameToExtensionManifest } = require("./branding");

test("applyNameToExtensionManifest prefers displayName over app.name", () => {
  const manifest = { name: "OldName", action: { default_title: "OldName" } };
  const changed = applyNameToExtensionManifest(manifest, { app: { name: "TeamClu", displayName: "TeamClu 龙虾团" } });
  assert.strictEqual(changed, true);
  assert.strictEqual(manifest.name, "TeamClu 龙虾团");
  assert.strictEqual(manifest.action.default_title, "TeamClu 龙虾团");
});

test("applyNameToExtensionManifest falls back to app.name when displayName is unset", () => {
  const manifest = { name: "OldName", action: { default_title: "OldName" } };
  const changed = applyNameToExtensionManifest(manifest, { app: { name: "TeamClu" } });
  assert.strictEqual(changed, true);
  assert.strictEqual(manifest.name, "TeamClu");
});

// Regression: the name was branded but the description was not, so the
// "Copilot 361" package reached review still describing itself as TeamClu.
test("applyNameToExtensionManifest brands the description from extension.description", () => {
  const manifest = { name: "TeamClu", description: "TeamClu sidebar", action: { default_title: "TeamClu" } };
  const changed = applyNameToExtensionManifest(manifest, {
    app: { name: "Acme" },
    extension: { description: "Acme sidebar" },
  });
  assert.strictEqual(changed, true);
  assert.strictEqual(manifest.name, "Acme");
  assert.strictEqual(manifest.description, "Acme sidebar");
});

test("applyNameToExtensionManifest accepts the canonical extensions.description too", () => {
  const manifest = { name: "TeamClu", description: "old" };
  applyNameToExtensionManifest(manifest, { app: { name: "Acme" }, extensions: { description: "new" } });
  assert.strictEqual(manifest.description, "new");
});

test("applyNameToExtensionManifest leaves the description alone when the brand sets none", () => {
  const manifest = { name: "TeamClu", description: "kept" };
  applyNameToExtensionManifest(manifest, { app: { name: "Acme" } });
  assert.strictEqual(manifest.description, "kept");
});

test("applyNameToExtensionManifest rejects a description Chrome would refuse", () => {
  const manifest = { name: "TeamClu", description: "short" };
  assert.throws(
    () => applyNameToExtensionManifest(manifest, { extension: { description: "x".repeat(133) } }),
    /at most 132/
  );
});

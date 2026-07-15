"use strict";
const test = require("node:test");
const assert = require("node:assert");
const { applyNameToTauriConf } = require("./branding");

test("applyNameToTauriConf sets productName and window title from app.name", () => {
  const conf = { productName: "TeamClaw", app: { windows: [{ title: "TeamClaw" }] } };
  const changed = applyNameToTauriConf(conf, { app: { name: "Acme" } });
  assert.strictEqual(changed, true);
  assert.strictEqual(conf.productName, "Acme");
  assert.strictEqual(conf.app.windows[0].title, "Acme");
});

test("applyNameToTauriConf is a no-op when app.name is absent", () => {
  const conf = { productName: "TeamClaw", app: { windows: [{ title: "TeamClaw" }] } };
  const changed = applyNameToTauriConf(conf, { app: {} });
  assert.strictEqual(changed, false);
  assert.strictEqual(conf.productName, "TeamClaw");
});

test("applyNameToTauriConf tolerates missing windows array", () => {
  const conf = { productName: "TeamClaw", app: {} };
  const changed = applyNameToTauriConf(conf, { app: { name: "Acme" } });
  assert.strictEqual(changed, true);
  assert.strictEqual(conf.productName, "Acme");
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
    identifier: "com.teamclaw.app",
    plugins: { "deep-link": { desktop: { schemes: ["teamclaw"] } } },
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
  assert.strictEqual(conf.identifier, "com.teamclaw.app");
  assert.deepStrictEqual(conf.plugins["deep-link"].desktop.schemes, ["teamclaw"]);
});

test("applyIdentityToTauriConf sets only identifier when only identifier given", () => {
  const conf = baseConf();
  const changed = applyIdentityToTauriConf(conf, { app: { identifier: "com.acme.app" } });
  assert.strictEqual(changed, true);
  assert.strictEqual(conf.identifier, "com.acme.app");
  assert.deepStrictEqual(conf.plugins["deep-link"].desktop.schemes, ["teamclaw"]);
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
  assert.strictEqual(conf.identifier, "com.teamclaw.app");
  assert.deepStrictEqual(conf.plugins["deep-link"].desktop.schemes, ["acme"]);
});

test("applyIdentityToTauriConf creates the deep-link path when missing", () => {
  const conf = { identifier: "com.teamclaw.app" };
  const changed = applyIdentityToTauriConf(conf, { app: { scheme: "acme" } });
  assert.strictEqual(changed, true);
  assert.deepStrictEqual(conf.plugins["deep-link"].desktop.schemes, ["acme"]);
});

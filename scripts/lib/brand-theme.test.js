"use strict";
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const nodePath = require("node:path");
const {
  extractRootTokenNames,
  generateBrandThemeCss,
  resolveBrandTheme,
} = require("./brand-theme");

const SAMPLE_CSS = `
:root {
  --background: #fff;
  --primary: #111;
}
.dark {
  --background: #000;
  --only-in-dark: #abc;
}
:root[data-palette="teal"] {
  --only-in-teal: #0f6e62;
}
`;

test("extractRootTokenNames returns only the bare :root block tokens", () => {
  const names = extractRootTokenNames(SAMPLE_CSS);
  assert.ok(names.has("--background"));
  assert.ok(names.has("--primary"));
  assert.ok(!names.has("--only-in-dark"));
  assert.ok(!names.has("--only-in-teal"));
  assert.strictEqual(names.size, 2);
});

test("generateBrandThemeCss emits one rule for the given palette + tokens", () => {
  const allowed = new Set(["--primary", "--background"]);
  const css = generateBrandThemeCss("acme", { "--primary": "#0f6e62" }, allowed);
  assert.strictEqual(css, ':root[data-palette="acme"]{--primary:#0f6e62;}');
});

test("generateBrandThemeCss throws on an unknown token name", () => {
  const allowed = new Set(["--primary"]);
  assert.throws(
    () => generateBrandThemeCss("acme", { "--bogus": "#000" }, allowed),
    /unknown.*--bogus/i
  );
});

test("generateBrandThemeCss throws on a non --token key", () => {
  const allowed = new Set(["--primary"]);
  assert.throws(
    () => generateBrandThemeCss("acme", { primary: "#000" }, allowed),
    /unknown.*primary/i
  );
});

test("generateBrandThemeCss throws on a dangerous value", () => {
  const allowed = new Set(["--primary"]);
  assert.throws(
    () => generateBrandThemeCss("acme", { "--primary": "#000;}body{x" }, allowed),
    /invalid.*--primary/i
  );
});

test("resolveBrandTheme returns null for default/teal/empty palettes", () => {
  assert.strictEqual(resolveBrandTheme({ app: {} }, "/repo"), null);
  assert.strictEqual(resolveBrandTheme({ app: { palette: "default" } }, "/repo"), null);
  assert.strictEqual(resolveBrandTheme({ app: { palette: "teal" } }, "/repo"), null);
});

test("resolveBrandTheme returns null when theme.json is missing", () => {
  assert.strictEqual(
    resolveBrandTheme({ app: { palette: "nope-no-such-brand" } }, "/repo"),
    null
  );
});

test("generateBrandThemeCss throws on an angle-bracket value (</style> breakout)", () => {
  const allowed = new Set(["--primary"]);
  assert.throws(
    () => generateBrandThemeCss("acme", { "--primary": "red</style>" }, allowed),
    /invalid.*--primary/i
  );
});

test("generateBrandThemeCss throws on a malformed palette id", () => {
  const allowed = new Set(["--primary"]);
  assert.throws(
    () => generateBrandThemeCss('a"]{}evil', { "--primary": "#000" }, allowed),
    /palette/i
  );
});

test("extractRootTokenNames merges tokens across multiple :root blocks and allows underscores", () => {
  const css = ":root { --a: 1; --a_b: 2; }\n:root { --c: 3; }";
  const names = extractRootTokenNames(css);
  assert.ok(names.has("--a") && names.has("--a_b") && names.has("--c"));
  assert.strictEqual(names.size, 3);
});

test("resolveBrandTheme reads tokens from branding/<palette>/theme.json", () => {
  const root = fs.mkdtempSync(nodePath.join(os.tmpdir(), "brand-theme-"));
  fs.mkdirSync(nodePath.join(root, "branding", "acme"), { recursive: true });
  fs.writeFileSync(
    nodePath.join(root, "branding", "acme", "theme.json"),
    JSON.stringify({ tokens: { "--primary": "#0f6e62" } })
  );
  const result = resolveBrandTheme({ app: { palette: "acme" } }, root);
  assert.deepStrictEqual(result, { palette: "acme", tokens: { "--primary": "#0f6e62" } });
});

test("resolveBrandTheme throws when theme.json lacks a tokens object", () => {
  const root = fs.mkdtempSync(nodePath.join(os.tmpdir(), "brand-theme-"));
  fs.mkdirSync(nodePath.join(root, "branding", "bad"), { recursive: true });
  fs.writeFileSync(
    nodePath.join(root, "branding", "bad", "theme.json"),
    JSON.stringify({ foo: 1 })
  );
  assert.throws(() => resolveBrandTheme({ app: { palette: "bad" } }, root), /tokens/);
});

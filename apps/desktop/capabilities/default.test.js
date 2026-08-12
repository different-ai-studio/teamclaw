"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

// Cold-start session deeplinks on macOS land in the deep-link plugin's
// `current` slot before the webview mounts. The frontend recovers them via
// `getCurrent()`, which requires this ACL permission. Without it the invoke
// is denied, the catch in App.tsx swallows the error, and the first open only
// launches the app.
test("default capabilities allow deep-link getCurrent for cold-start URLs", () => {
  const raw = fs.readFileSync(path.join(__dirname, "default.json"), "utf8");
  const caps = JSON.parse(raw);
  assert.ok(
    Array.isArray(caps.permissions) && caps.permissions.includes("deep-link:default"),
    'expected "deep-link:default" in apps/desktop/capabilities/default.json permissions',
  );
});

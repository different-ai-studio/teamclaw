"use strict";

import { test } from "node:test";
import assert from "node:assert/strict";
import { renderDesktopReleaseBody } from "./render-desktop-release-body.mjs";

test("renderDesktopReleaseBody uses branded app name and quoted quarantine path", () => {
  const body = renderDesktopReleaseBody({ appName: "Copilot 361", macArchHint: true });
  assert.match(body, /drag \*\*Copilot 361\*\* to Applications/);
  assert.match(
    body,
    /sudo xattr -dr com\.apple\.quarantine "\/Applications\/Copilot 361\.app"/,
  );
  assert.match(body, /Open \*\*Copilot 361\*\* from Applications/);
  assert.match(body, /Copilot 361 is not yet notarized/);
});

test("renderDesktopReleaseBody quotes application path for shell safety", () => {
  const body = renderDesktopReleaseBody({ appName: "TeamClaw", macArchHint: false });
  assert.match(body, /sudo xattr -dr com\.apple\.quarantine "\/Applications\/TeamClaw\.app"/);
});

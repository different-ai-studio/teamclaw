import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeAgentTypes } from "../src/lib/agent-types.js";

test("keeps supported/default unchanged when default is already a member", () => {
  const out = normalizeAgentTypes(["claude", "opencode"], "claude");
  assert.deepEqual(out, { supportedTypes: ["claude", "opencode"], defaultAgentType: "claude" });
});

test("includes the default when the supported list omits it (the reported bug)", () => {
  const out = normalizeAgentTypes(["opencode"], "claude");
  assert.deepEqual(out, { supportedTypes: ["claude", "opencode"], defaultAgentType: "claude" });
});

test("falls back to the first supported type when no default is given", () => {
  const out = normalizeAgentTypes(["opencode", "codex"], null);
  assert.deepEqual(out, { supportedTypes: ["opencode", "codex"], defaultAgentType: "opencode" });
});

test("dedupes and drops empties", () => {
  const out = normalizeAgentTypes(["claude", "", "claude", "opencode"], "claude");
  assert.deepEqual(out, { supportedTypes: ["claude", "opencode"], defaultAgentType: "claude" });
});

test("handles empty/null inputs", () => {
  assert.deepEqual(normalizeAgentTypes(null, null), { supportedTypes: [], defaultAgentType: null });
  assert.deepEqual(normalizeAgentTypes([], "claude"), { supportedTypes: ["claude"], defaultAgentType: "claude" });
});

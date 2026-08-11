import { describe, expect, it } from "vitest";

import {
  AGENT_TYPE_ORDER,
  normalizeStoredAgentType,
  resolveInitialAgentType,
  supportedAgentTypes,
} from "../features/sessions/components/agent-config-helpers";

describe("normalizeStoredAgentType", () => {
  it("folds the three spellings of Claude together", () => {
    // Which one is stored depends on which writer got there first.
    for (const stored of ["claude", "claude_code", "claude-code"]) {
      expect(normalizeStoredAgentType(stored)).toBe("claude");
    }
  });

  it("passes the other two through", () => {
    expect(normalizeStoredAgentType("opencode")).toBe("opencode");
    expect(normalizeStoredAgentType("codex")).toBe("codex");
  });

  it("returns null for anything it does not recognise", () => {
    expect(normalizeStoredAgentType("pi")).toBeNull();
    expect(normalizeStoredAgentType("")).toBeNull();
    expect(normalizeStoredAgentType(null)).toBeNull();
    expect(normalizeStoredAgentType(undefined)).toBeNull();
  });
});

describe("supportedAgentTypes", () => {
  it("offers only what the agent reports", () => {
    // Offering more is not cosmetic: picking a backend the agent cannot run
    // sends a runtime_start the daemon cannot honour.
    expect(supportedAgentTypes(["opencode"])).toEqual(["opencode"]);
    expect(supportedAgentTypes(["codex", "opencode"])).toEqual(["opencode", "codex"]);
  });

  it("keeps the canonical display order, not the stored order", () => {
    expect(supportedAgentTypes(["codex", "claude", "opencode"])).toEqual([
      "claude",
      "opencode",
      "codex",
    ]);
  });

  it("dedupes the Claude spellings", () => {
    expect(supportedAgentTypes(["claude", "claude_code"])).toEqual(["claude"]);
  });

  it("falls back to everything when the list is empty or unusable", () => {
    // Better to offer all than to offer none — same call iOS makes.
    expect(supportedAgentTypes([])).toEqual(AGENT_TYPE_ORDER);
    expect(supportedAgentTypes(null)).toEqual(AGENT_TYPE_ORDER);
    expect(supportedAgentTypes(undefined)).toEqual(AGENT_TYPE_ORDER);
    expect(supportedAgentTypes(["pi", "cursor"])).toEqual(AGENT_TYPE_ORDER);
  });

  it("ignores the unrecognised entries when some are recognised", () => {
    expect(supportedAgentTypes(["pi", "codex"])).toEqual(["codex"]);
  });
});

describe("resolveInitialAgentType", () => {
  it("keeps the preferred type when it is on offer", () => {
    expect(resolveInitialAgentType("codex", ["claude", "codex"])).toBe("codex");
  });

  it("clamps to the first offer when it is not", () => {
    // Otherwise no segment looks selected and confirming still sends the
    // unsupported type.
    expect(resolveInitialAgentType("codex", ["claude", "opencode"])).toBe("claude");
  });

  it("leaves the preference alone when nothing is on offer", () => {
    expect(resolveInitialAgentType("codex", [])).toBe("codex");
  });
});

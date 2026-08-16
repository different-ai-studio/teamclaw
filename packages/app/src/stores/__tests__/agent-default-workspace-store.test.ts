import { describe, it, expect, beforeEach } from "vitest";
import {
  useAgentDefaultWorkspaceStore,
  cachedDefaultWorkspaceId,
  rememberDefaultWorkspaceId,
} from "@/stores/agent-default-workspace-store";

beforeEach(() => {
  useAgentDefaultWorkspaceStore.getState().clear();
});

describe("agent default workspace cache", () => {
  it("remembers a live-resolved id per agent", () => {
    rememberDefaultWorkspaceId(["agent-a"], "ws-1");
    rememberDefaultWorkspaceId(["agent-b"], "ws-2");
    expect(cachedDefaultWorkspaceId(["agent-a"])).toBe("ws-1");
    expect(cachedDefaultWorkspaceId(["agent-b"])).toBe("ws-2");
    expect(cachedDefaultWorkspaceId(["agent-unknown"])).toBe("");
  });

  it("returns the first agent that has a cached id", () => {
    rememberDefaultWorkspaceId(["agent-b"], "ws-2");
    expect(cachedDefaultWorkspaceId(["agent-a", "agent-b"])).toBe("ws-2");
  });

  it("is overwritten by a newer live value", () => {
    // The whole ordering rule: this is server-owned config, so a later live
    // answer replaces the cache. If it did not, changing the default workspace
    // on another device would keep starting runtimes in the old directory.
    rememberDefaultWorkspaceId(["agent-a"], "ws-old");
    rememberDefaultWorkspaceId(["agent-a"], "ws-new");
    expect(cachedDefaultWorkspaceId(["agent-a"])).toBe("ws-new");
  });

  it("ignores blank writes rather than caching an empty answer", () => {
    rememberDefaultWorkspaceId(["agent-a"], "ws-1");
    rememberDefaultWorkspaceId(["agent-a"], "   ");
    rememberDefaultWorkspaceId([""], "ws-2");
    expect(cachedDefaultWorkspaceId(["agent-a"])).toBe("ws-1");
  });

  it("survives across store instances (persisted)", () => {
    rememberDefaultWorkspaceId(["agent-a"], "ws-1");
    expect(localStorage.getItem("teamclu.agent-default-workspace.v1")).toBeTruthy();
  });

  it("returns empty for an empty agent list", () => {
    expect(cachedDefaultWorkspaceId([])).toBe("");
  });
});

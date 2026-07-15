import { describe, expect, it } from "vitest";

import { resolveSlashCommands } from "../features/sessions/components/runtime-commands";
import { BUILT_IN_SLASH_COMMANDS } from "../features/sessions/components/slash-commands";
import type { RuntimeInfo } from "../features/actors/connected-agent-types";

function baseRuntimeInfo(over: Partial<RuntimeInfo>): RuntimeInfo {
  return {
    runtimeId: "r", agentType: 1, worktree: "", branch: "",
    status: 0, startedAt: 0, currentPrompt: "", workspaceId: "",
    sessionTitle: "", toolUseCount: 0, availableModels: [],
    currentModel: "", state: 0, stage: "", errorCode: "",
    errorMessage: "", failedStage: "", availableCommands: [],
    ...over,
  };
}

describe("resolveSlashCommands", () => {
  it("returns built-in when no runtimes have announced", () => {
    const out = resolveSlashCommands([], BUILT_IN_SLASH_COMMANDS);
    expect(out).toEqual([...BUILT_IN_SLASH_COMMANDS]);
  });

  it("returns built-in when runtimes report empty arrays", () => {
    const out = resolveSlashCommands(
      [baseRuntimeInfo({ availableCommands: [] })],
      BUILT_IN_SLASH_COMMANDS,
    );
    expect(out).toEqual([...BUILT_IN_SLASH_COMMANDS]);
  });

  it("returns runtime commands when at least one has announced", () => {
    const out = resolveSlashCommands(
      [baseRuntimeInfo({
        availableCommands: [
          { name: "custom", description: "Do thing", inputHint: "" },
        ],
      })],
      BUILT_IN_SLASH_COMMANDS,
    );
    expect(out).toEqual([
      { name: "custom", description: "Do thing", inputHint: "" },
    ]);
  });

  it("first runtime wins on duplicate names across runtimes", () => {
    const out = resolveSlashCommands(
      [
        baseRuntimeInfo({
          availableCommands: [
            { name: "clear", description: "From rt1", inputHint: "" },
          ],
        }),
        baseRuntimeInfo({
          availableCommands: [
            { name: "clear", description: "From rt2", inputHint: "" },
            { name: "extra", description: "Only rt2", inputHint: "" },
          ],
        }),
      ],
      BUILT_IN_SLASH_COMMANDS,
    );
    expect(out).toEqual([
      { name: "clear", description: "From rt1", inputHint: "" },
      { name: "extra", description: "Only rt2", inputHint: "" },
    ]);
  });
});

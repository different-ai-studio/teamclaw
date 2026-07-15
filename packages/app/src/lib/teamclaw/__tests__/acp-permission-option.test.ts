import { describe, expect, it } from "vitest";
import {
  acpOptionIdForDecision,
  defaultOpenCodePermissionOptions,
} from "@/lib/teamclaw/acp-permission-option";

describe("acpOptionIdForDecision", () => {
  it("maps always to allow_always option id", () => {
    expect(
      acpOptionIdForDecision("always", { options: defaultOpenCodePermissionOptions() }),
    ).toBe("always");
  });

  it("maps allow to allow_once option id", () => {
    expect(
      acpOptionIdForDecision("allow", { options: defaultOpenCodePermissionOptions() }),
    ).toBe("once");
  });

  it("returns undefined for deny", () => {
    expect(acpOptionIdForDecision("deny", { options: defaultOpenCodePermissionOptions() })).toBe(
      undefined,
    );
  });
});

import { describe, expect, it } from "vitest";

import {
  agentButtonLabel,
  composerInputMode,
  composerRightButton,
} from "../features/sessions/components/composer-state";

describe("composerRightButton", () => {
  it("prefers stopping the recording over anything else", () => {
    expect(composerRightButton({ hasText: true, isRecording: true })).toBe("stopRecording");
    expect(composerRightButton({ hasText: false, isRecording: true })).toBe("stopRecording");
  });

  it("sends when there is text, otherwise offers the mic", () => {
    expect(composerRightButton({ hasText: true, isRecording: false })).toBe("send");
    expect(composerRightButton({ hasText: false, isRecording: false })).toBe("mic");
  });
});

describe("composerInputMode", () => {
  it("swaps the whole input for the waveform while recording", () => {
    expect(composerInputMode(true)).toBe("waveform");
    expect(composerInputMode(false)).toBe("textField");
  });
});

describe("agentButtonLabel", () => {
  it("is icon-only when nothing is selected", () => {
    expect(agentButtonLabel([])).toBeNull();
  });

  it("names a single agent, and counts the rest", () => {
    expect(agentButtonLabel(["Claude"])).toBe("Claude");
    // Multiplication sign, not the letter x — matches iOS `×`.
    expect(agentButtonLabel(["Claude", "OpenCode"])).toBe("Claude ×2");
    expect(agentButtonLabel(["Claude", "OpenCode", "Codex"])).toBe("Claude ×3");
  });
});

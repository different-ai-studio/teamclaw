import { describe, expect, it, vi } from "vitest";

vi.mock("react-native", () => ({
  Platform: {
    OS: "ios",
    select: (values: Record<string, unknown>) => values.ios ?? values.default,
  },
}));

import { appStatusBarProps } from "../ui/status-bar";
import { colors } from "../ui/theme";

describe("appStatusBarProps", () => {
  it("keeps status bar content dark on the light Hai app surface", () => {
    expect(appStatusBarProps).toMatchObject({
      backgroundColor: colors.background,
      style: "dark",
    });
  });
});

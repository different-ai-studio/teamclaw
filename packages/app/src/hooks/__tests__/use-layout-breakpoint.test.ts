import { describe, expect, it } from "vitest";

import { getLayoutBreakpointForWidth } from "../use-layout-breakpoint";

describe("getLayoutBreakpointForWidth", () => {
  it("keeps the session list hidden until the message pane has more room", () => {
    expect(getLayoutBreakpointForWidth(899)).toBe("narrow");
    expect(getLayoutBreakpointForWidth(900)).toBe("medium");
    expect(getLayoutBreakpointForWidth(1023)).toBe("medium");
    expect(getLayoutBreakpointForWidth(1024)).toBe("wide");
  });
});

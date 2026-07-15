import { cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { useTerminalStore } from "@/stores/terminal-store";
import { TerminalTabBar } from "@/components/terminal/TerminalTabBar";

vi.mock("@/lib/terminal/client", () => ({
  openTerminal: vi.fn(async () => ({ id: "tab-1", shell: "/bin/zsh", pid: 100 })),
  closeTerminal: vi.fn(async () => {}),
  listTerminals: vi.fn(async () => []),
}));

describe("TerminalTabBar", () => {
  beforeEach(() => {
    useTerminalStore.setState({
      tabsByWorkspace: {},
      activeTabByWorkspace: {},
      panelOpenByWorkspace: {},
      panelHeightByWorkspace: {},
    });
  });

  afterEach(() => cleanup());

  test("renders an empty workspace without resubscribing forever", () => {
    expect(() =>
      render(
        <TerminalTabBar
          workspaceId="ws1"
          workspacePath="/tmp"
          allowedRoots={["/tmp"]}
        />,
      ),
    ).not.toThrow();
  });
});

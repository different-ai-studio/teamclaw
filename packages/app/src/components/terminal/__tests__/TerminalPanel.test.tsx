import { cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { useTerminalStore } from "@/stores/terminal-store";
import { TerminalPanel } from "@/components/terminal/TerminalPanel";

const { openTerminalMock } = vi.hoisted(() => ({
  openTerminalMock: vi.fn(async () => ({
    id: "tab-1",
    shell: "/bin/zsh",
    pid: 100,
  })),
}));

vi.mock("@/lib/terminal/client", () => ({
  openTerminal: openTerminalMock,
  closeTerminal: vi.fn(async () => {}),
  listTerminals: vi.fn(async () => []),
}));

vi.mock("@/components/terminal/XtermInstance", () => ({
  XtermInstance: () => <div data-testid="xterm-instance" />,
}));

describe("TerminalPanel", () => {
  beforeEach(() => {
    openTerminalMock.mockClear();
    useTerminalStore.setState({
      tabsByWorkspace: {},
      activeTabByWorkspace: {},
      panelOpenByWorkspace: {},
      panelHeightByWorkspace: {},
    });
  });

  afterEach(() => cleanup());

  test("opens only one initial tab while the first open is still pending", async () => {
    const { rerender } = render(
      <TerminalPanel
        workspaceId="ws1"
        workspacePath="/tmp"
        allowedRoots={["/tmp"]}
      />,
    );

    rerender(
      <TerminalPanel
        workspaceId="ws1"
        workspacePath="/tmp"
        allowedRoots={["/tmp"]}
      />,
    );

    await waitFor(() => {
      expect(openTerminalMock).toHaveBeenCalledTimes(1);
    });
  });
});

import { beforeEach, describe, expect, test, vi } from "vitest";
import { useTerminalStore } from "@/stores/terminal-store";

vi.mock("@/lib/terminal/client", () => ({
  openTerminal: vi.fn(async () => ({ id: "tab-1", shell: "/bin/zsh", pid: 100 })),
  closeTerminal: vi.fn(async () => {}),
  listTerminals: vi.fn(async () => []),
}));

const seedTab = (id: string, workspaceId: string) => ({
  id,
  workspaceId,
  title: "zsh",
  pid: 100,
  shell: "/bin/zsh",
  cwd: "/tmp",
  status: "running" as const,
});

describe("terminal-store", () => {
  beforeEach(() => {
    useTerminalStore.setState({
      tabsByWorkspace: {},
      activeTabByWorkspace: {},
      panelOpenByWorkspace: {},
      panelHeightByWorkspace: {},
    });
  });

  test("openTerminal appends a tab and sets it active", async () => {
    await useTerminalStore.getState().openTerminal("ws1", {
      cwd: "/tmp",
      allowedRoots: ["/tmp"],
    });
    const s = useTerminalStore.getState();
    expect(s.tabsByWorkspace["ws1"]?.length).toBe(1);
    expect(s.activeTabByWorkspace["ws1"]).toBe("tab-1");
  });

  test("togglePanel flips open/closed", () => {
    useTerminalStore.getState().togglePanel("ws1");
    expect(useTerminalStore.getState().panelOpenByWorkspace["ws1"]).toBe(true);
    useTerminalStore.getState().togglePanel("ws1");
    expect(useTerminalStore.getState().panelOpenByWorkspace["ws1"]).toBe(false);
  });

  test("renameTab updates title", () => {
    useTerminalStore.setState({
      tabsByWorkspace: { ws1: [seedTab("a", "ws1")] },
    });
    useTerminalStore.getState().renameTab("a", "build");
    expect(useTerminalStore.getState().tabsByWorkspace["ws1"][0].title).toBe("build");
  });

  test("closeTerminal removes tab and clears active when no remain", async () => {
    useTerminalStore.setState({
      tabsByWorkspace: { ws1: [seedTab("a", "ws1")] },
      activeTabByWorkspace: { ws1: "a" },
    });
    await useTerminalStore.getState().closeTerminal("a");
    const s = useTerminalStore.getState();
    expect(s.tabsByWorkspace["ws1"]).toEqual([]);
    expect(s.activeTabByWorkspace["ws1"]).toBeNull();
  });

  test("closeTerminal picks neighbor when closing active", async () => {
    useTerminalStore.setState({
      tabsByWorkspace: { ws1: [seedTab("a", "ws1"), seedTab("b", "ws1"), seedTab("c", "ws1")] },
      activeTabByWorkspace: { ws1: "b" },
    });
    await useTerminalStore.getState().closeTerminal("b");
    expect(useTerminalStore.getState().activeTabByWorkspace["ws1"]).toBe("a");
  });

  test("markExited updates status, keeps tab present", () => {
    useTerminalStore.setState({
      tabsByWorkspace: { ws1: [seedTab("a", "ws1")] },
    });
    useTerminalStore.getState().markExited("a", 0);
    const tab = useTerminalStore.getState().tabsByWorkspace["ws1"][0];
    expect(tab.status).toBe("exited");
    expect(tab.exitCode).toBe(0);
  });
});

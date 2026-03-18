import { describe, it, expect, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { useTabsStore } from "@/stores/tabs";
import { TabBar } from "@/components/tab-bar/TabBar";

describe("TabBar", () => {
  beforeEach(() => {
    useTabsStore.setState({ tabs: [], activeTabId: null });
  });

  it("renders nothing when no tabs are open", () => {
    const { container } = render(<TabBar />);
    expect(container.innerHTML).toBe("");
  });

  it("renders one tab item per open tab", () => {
    const { openTab } = useTabsStore.getState();
    openTab({ type: "file", target: "/foo.ts", label: "foo.ts" });
    openTab({ type: "webview", target: "https://google.com", label: "Google" });
    openTab({ type: "native", target: "dashboard", label: "Dashboard" });
    render(<TabBar />);
    expect(screen.getByText("foo.ts")).toBeTruthy();
    expect(screen.getByText("Google")).toBeTruthy();
    expect(screen.getByText("Dashboard")).toBeTruthy();
  });

  it("active tab has distinct style", () => {
    const { openTab } = useTabsStore.getState();
    openTab({ type: "file", target: "/a.ts", label: "a.ts" });
    openTab({ type: "file", target: "/b.ts", label: "b.ts" });
    render(<TabBar />);
    const tabs = screen.getAllByRole("tab");
    // b.ts is active (last opened)
    expect(tabs[1].getAttribute("data-active")).toBe("true");
    expect(tabs[0].getAttribute("data-active")).toBe("false");
  });

  it("each tab has a close button", () => {
    useTabsStore.getState().openTab({ type: "file", target: "/a.ts", label: "a.ts" });
    render(<TabBar />);
    const closeButtons = screen.getAllByRole("button", { name: /close/i });
    expect(closeButtons).toHaveLength(1);
  });

  it("clicking tab switches active", () => {
    const { openTab } = useTabsStore.getState();
    openTab({ type: "file", target: "/a.ts", label: "a.ts" });
    openTab({ type: "file", target: "/b.ts", label: "b.ts" });
    render(<TabBar />);
    const tabs = screen.getAllByRole("tab");
    fireEvent.click(tabs[0]); // click a.ts
    expect(useTabsStore.getState().activeTabId).toBe(
      useTabsStore.getState().tabs[0].id,
    );
  });

  it("clicking close button removes tab", () => {
    useTabsStore.getState().openTab({ type: "file", target: "/a.ts", label: "a.ts" });
    render(<TabBar />);
    const closeBtn = screen.getByRole("button", { name: /close/i });
    fireEvent.click(closeBtn);
    expect(useTabsStore.getState().tabs).toHaveLength(0);
  });

  it("middle-click closes tab", () => {
    const { openTab } = useTabsStore.getState();
    openTab({ type: "file", target: "/a.ts", label: "a.ts" });
    openTab({ type: "file", target: "/b.ts", label: "b.ts" });
    render(<TabBar />);
    const tabs = screen.getAllByRole("tab");
    fireEvent.mouseDown(tabs[0], { button: 1 });
    expect(useTabsStore.getState().tabs).toHaveLength(1);
    expect(useTabsStore.getState().tabs[0].target).toBe("/b.ts");
  });

  it("right-click shows context menu", () => {
    useTabsStore.getState().openTab({ type: "file", target: "/a.ts", label: "a.ts" });
    render(<TabBar />);
    const tab = screen.getByRole("tab");
    fireEvent.contextMenu(tab);
    expect(screen.getByText("Close")).toBeTruthy();
    expect(screen.getByText("Close Others")).toBeTruthy();
    expect(screen.getByText("Close All")).toBeTruthy();
  });

  it("dirty dot visible when dirty is true", () => {
    useTabsStore.getState().openTab({ type: "file", target: "/a.ts", label: "a.ts" });
    const tabId = useTabsStore.getState().tabs[0].id;
    useTabsStore.getState().setDirty(tabId, true);
    const { container } = render(<TabBar />);
    const dot = container.querySelector("[data-dirty='true']");
    expect(dot).toBeTruthy();
  });
});

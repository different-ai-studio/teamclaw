import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { useTabsStore } from "@/stores/tabs";

// Mock the heavy content components
vi.mock("@/components/main-content/WebViewContent", () => ({
  WebViewContent: ({ url }: { url: string }) => (
    <div data-testid="webview-content">{url}</div>
  ),
}));

vi.mock("@/components/main-content/NativeContent", () => ({
  NativeContent: ({ target }: { target: string }) => (
    <div data-testid="native-content">{target}</div>
  ),
}));

// Import after mocks
import { TabContentRenderer } from "@/components/tab-bar/TabContentRenderer";

describe("TabContentRenderer", () => {
  beforeEach(() => {
    useTabsStore.setState({ tabs: [], activeTabId: null });
  });

  it("renders nothing when no active tab", () => {
    const { container } = render(<TabContentRenderer />);
    expect(container.innerHTML).toBe("");
  });

  it("renders webview content for webview tab", () => {
    useTabsStore.getState().openTab({
      type: "webview",
      target: "https://example.com",
      label: "Example",
    });
    render(<TabContentRenderer />);
    expect(screen.getByTestId("webview-content")).toBeTruthy();
    expect(screen.getByText("https://example.com")).toBeTruthy();
  });

  it("renders native content for native tab", () => {
    useTabsStore.getState().openTab({
      type: "native",
      target: "dashboard",
      label: "Dashboard",
    });
    render(<TabContentRenderer />);
    expect(screen.getByTestId("native-content")).toBeTruthy();
    expect(screen.getByText("dashboard")).toBeTruthy();
  });

  it("renders file content area for file tab with correct target", () => {
    useTabsStore.getState().openTab({
      type: "file",
      target: "/path/foo.ts",
      label: "foo.ts",
    });
    render(<TabContentRenderer />);
    const fileEl = screen.getByTestId("file-content");
    expect(fileEl).toBeTruthy();
    expect(fileEl.getAttribute("data-file-target")).toBe("/path/foo.ts");
  });

  it("switches content when active tab changes", () => {
    const { openTab } = useTabsStore.getState();
    openTab({ type: "webview", target: "https://a.com", label: "A" });
    openTab({ type: "native", target: "dash", label: "Dash" });
    const { rerender } = render(<TabContentRenderer />);
    // native is active (last opened)
    expect(screen.getByTestId("native-content")).toBeTruthy();
    // switch to webview tab
    useTabsStore.getState().setActiveTab(useTabsStore.getState().tabs[0].id);
    rerender(<TabContentRenderer />);
    expect(screen.getByTestId("webview-content")).toBeTruthy();
  });
});

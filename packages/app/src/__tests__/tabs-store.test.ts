import { describe, it, expect, beforeEach } from "vitest";
import { useTabsStore } from "@/stores/tabs";

describe("tabsStore", () => {
  beforeEach(() => {
    useTabsStore.setState({ tabs: [], activeTabId: null });
  });

  describe("openTab", () => {
    it("creates a tab with correct shape", () => {
      useTabsStore.getState().openTab({ type: "file", target: "/path/foo.ts", label: "foo.ts" });
      const tabs = useTabsStore.getState().tabs;
      expect(tabs).toHaveLength(1);
      expect(tabs[0]).toMatchObject({
        type: "file",
        target: "/path/foo.ts",
        label: "foo.ts",
        dirty: false,
      });
      expect(tabs[0].id).toBeTruthy();
    });

    it("activates the new tab", () => {
      useTabsStore.getState().openTab({ type: "file", target: "/path/foo.ts", label: "foo.ts" });
      const { tabs, activeTabId } = useTabsStore.getState();
      expect(activeTabId).toBe(tabs[0].id);
    });

    it("appends new tabs at the end", () => {
      const { openTab } = useTabsStore.getState();
      openTab({ type: "file", target: "/a.ts", label: "a.ts" });
      openTab({ type: "file", target: "/b.ts", label: "b.ts" });
      openTab({ type: "file", target: "/c.ts", label: "c.ts" });
      const targets = useTabsStore.getState().tabs.map((t) => t.target);
      expect(targets).toEqual(["/a.ts", "/b.ts", "/c.ts"]);
    });

    it("singleton: same type+target activates existing tab", () => {
      const { openTab } = useTabsStore.getState();
      openTab({ type: "webview", target: "https://google.com", label: "Google" });
      const firstId = useTabsStore.getState().tabs[0].id;
      openTab({ type: "file", target: "/other.ts", label: "other.ts" });
      // Now open same webview again
      openTab({ type: "webview", target: "https://google.com", label: "Google" });
      const { tabs, activeTabId } = useTabsStore.getState();
      expect(tabs).toHaveLength(2); // no duplicate
      expect(activeTabId).toBe(firstId);
    });

    it("different type + same target creates new tab", () => {
      const { openTab } = useTabsStore.getState();
      openTab({ type: "file", target: "/path/foo", label: "foo" });
      openTab({ type: "native", target: "/path/foo", label: "Foo" });
      expect(useTabsStore.getState().tabs).toHaveLength(2);
    });
  });

  describe("getActiveTab", () => {
    it("returns the active tab object", () => {
      const { openTab } = useTabsStore.getState();
      openTab({ type: "file", target: "/a.ts", label: "a.ts" });
      openTab({ type: "file", target: "/b.ts", label: "b.ts" });
      const active = useTabsStore.getState().getActiveTab();
      expect(active).not.toBeNull();
      expect(active!.target).toBe("/b.ts");
    });

    it("returns null when no tab is active", () => {
      expect(useTabsStore.getState().getActiveTab()).toBeNull();
    });
  });

  describe("closeTab", () => {
    it("close active middle tab → right neighbor activated", () => {
      const { openTab } = useTabsStore.getState();
      openTab({ type: "file", target: "/a.ts", label: "a" });
      openTab({ type: "file", target: "/b.ts", label: "b" });
      openTab({ type: "file", target: "/c.ts", label: "c" });
      const tabs = useTabsStore.getState().tabs;
      // activate B
      useTabsStore.getState().setActiveTab(tabs[1].id);
      useTabsStore.getState().closeTab(tabs[1].id);
      const state = useTabsStore.getState();
      expect(state.tabs).toHaveLength(2);
      expect(state.activeTabId).toBe(tabs[2].id); // C (right neighbor)
    });

    it("close active rightmost tab → left neighbor activated", () => {
      const { openTab } = useTabsStore.getState();
      openTab({ type: "file", target: "/a.ts", label: "a" });
      openTab({ type: "file", target: "/b.ts", label: "b" });
      openTab({ type: "file", target: "/c.ts", label: "c" });
      const tabs = useTabsStore.getState().tabs;
      // C is already active (last opened)
      useTabsStore.getState().closeTab(tabs[2].id);
      const state = useTabsStore.getState();
      expect(state.tabs).toHaveLength(2);
      expect(state.activeTabId).toBe(tabs[1].id); // B (left neighbor)
    });

    it("close last remaining tab → activeTabId null", () => {
      useTabsStore.getState().openTab({ type: "file", target: "/a.ts", label: "a" });
      const tabId = useTabsStore.getState().tabs[0].id;
      useTabsStore.getState().closeTab(tabId);
      const state = useTabsStore.getState();
      expect(state.tabs).toHaveLength(0);
      expect(state.activeTabId).toBeNull();
    });

    it("close non-active tab → active tab preserved", () => {
      const { openTab } = useTabsStore.getState();
      openTab({ type: "file", target: "/a.ts", label: "a" });
      openTab({ type: "file", target: "/b.ts", label: "b" });
      openTab({ type: "file", target: "/c.ts", label: "c" });
      const tabs = useTabsStore.getState().tabs;
      // C is active, close A
      useTabsStore.getState().closeTab(tabs[0].id);
      const state = useTabsStore.getState();
      expect(state.tabs).toHaveLength(2);
      expect(state.activeTabId).toBe(tabs[2].id); // C still active
    });
  });

  describe("setActiveTab", () => {
    it("switches active tab", () => {
      const { openTab } = useTabsStore.getState();
      openTab({ type: "file", target: "/a.ts", label: "a" });
      openTab({ type: "file", target: "/b.ts", label: "b" });
      const tabs = useTabsStore.getState().tabs;
      useTabsStore.getState().setActiveTab(tabs[0].id);
      expect(useTabsStore.getState().activeTabId).toBe(tabs[0].id);
    });

    it("ignores invalid id", () => {
      useTabsStore.getState().openTab({ type: "file", target: "/a.ts", label: "a" });
      const before = useTabsStore.getState().activeTabId;
      useTabsStore.getState().setActiveTab("nonexistent");
      expect(useTabsStore.getState().activeTabId).toBe(before);
    });
  });

  describe("setDirty", () => {
    it("marks tab as dirty", () => {
      useTabsStore.getState().openTab({ type: "file", target: "/a.ts", label: "a" });
      const tabId = useTabsStore.getState().tabs[0].id;
      useTabsStore.getState().setDirty(tabId, true);
      expect(useTabsStore.getState().tabs[0].dirty).toBe(true);
    });

    it("clears dirty flag", () => {
      useTabsStore.getState().openTab({ type: "file", target: "/a.ts", label: "a" });
      const tabId = useTabsStore.getState().tabs[0].id;
      useTabsStore.getState().setDirty(tabId, true);
      useTabsStore.getState().setDirty(tabId, false);
      expect(useTabsStore.getState().tabs[0].dirty).toBe(false);
    });
  });

  describe("closeOthers", () => {
    it("keeps only specified tab", () => {
      const { openTab } = useTabsStore.getState();
      openTab({ type: "file", target: "/a.ts", label: "a" });
      openTab({ type: "file", target: "/b.ts", label: "b" });
      openTab({ type: "file", target: "/c.ts", label: "c" });
      openTab({ type: "file", target: "/d.ts", label: "d" });
      const tabB = useTabsStore.getState().tabs[1];
      useTabsStore.getState().closeOthers(tabB.id);
      const state = useTabsStore.getState();
      expect(state.tabs).toHaveLength(1);
      expect(state.tabs[0].id).toBe(tabB.id);
      expect(state.activeTabId).toBe(tabB.id);
    });
  });

  describe("closeAll", () => {
    it("removes all tabs", () => {
      const { openTab } = useTabsStore.getState();
      openTab({ type: "file", target: "/a.ts", label: "a" });
      openTab({ type: "file", target: "/b.ts", label: "b" });
      useTabsStore.getState().closeAll();
      const state = useTabsStore.getState();
      expect(state.tabs).toHaveLength(0);
      expect(state.activeTabId).toBeNull();
    });
  });
});

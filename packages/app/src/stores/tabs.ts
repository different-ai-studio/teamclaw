import { create } from "zustand";

export interface Tab {
  id: string;
  type: "file" | "webview" | "native";
  target: string;
  label: string;
  dirty: boolean;
}

interface OpenTabInput {
  type: Tab["type"];
  target: string;
  label: string;
}

let nextId = 1;

interface TabsState {
  tabs: Tab[];
  activeTabId: string | null;
  openTab: (item: OpenTabInput) => void;
  closeTab: (id: string) => void;
  setActiveTab: (id: string) => void;
  setDirty: (id: string, dirty: boolean) => void;
  closeOthers: (id: string) => void;
  closeAll: () => void;
  /** Deactivate all tabs without closing them — returns to agent view */
  hideAll: () => void;
  getActiveTab: () => Tab | null;
}

/** Zustand selector for the active tab. Use with `useTabsStore(selectActiveTab)`. */
export function selectActiveTab(s: TabsState): Tab | null {
  if (!s.activeTabId) return null;
  return s.tabs.find((t) => t.id === s.activeTabId) ?? null;
}

export const useTabsStore = create<TabsState>((set, get) => ({
  tabs: [],
  activeTabId: null,

  openTab: (item) => {
    const { tabs, activeTabId } = get();
    const existing = tabs.find(
      (t) => t.type === item.type && t.target === item.target,
    );
    if (existing) {
      // Skip state update if this tab is already active — prevents circular re-renders
      if (activeTabId !== existing.id) {
        set({ activeTabId: existing.id });
      }
      return;
    }
    const id = `tab-${nextId++}`;
    const tab: Tab = { id, ...item, dirty: false };
    set({ tabs: [...tabs, tab], activeTabId: id });
  },

  closeTab: (id) => {
    const { tabs, activeTabId } = get();
    const idx = tabs.findIndex((t) => t.id === id);
    if (idx === -1) return;
    const newTabs = tabs.filter((t) => t.id !== id);
    let newActive = activeTabId;
    if (activeTabId === id) {
      if (newTabs.length === 0) {
        newActive = null;
      } else if (idx < newTabs.length) {
        newActive = newTabs[idx].id; // right neighbor
      } else {
        newActive = newTabs[newTabs.length - 1].id; // left neighbor
      }
    }
    set({ tabs: newTabs, activeTabId: newActive });
  },

  setActiveTab: (id) => {
    const { tabs } = get();
    if (tabs.some((t) => t.id === id)) {
      set({ activeTabId: id });
    }
  },

  setDirty: (id, dirty) => {
    set({
      tabs: get().tabs.map((t) => (t.id === id ? { ...t, dirty } : t)),
    });
  },

  closeOthers: (id) => {
    const kept = get().tabs.filter((t) => t.id === id);
    set({ tabs: kept, activeTabId: kept.length > 0 ? id : null });
  },

  closeAll: () => {
    set({ tabs: [], activeTabId: null });
  },

  hideAll: () => {
    set({ activeTabId: null });
  },

  getActiveTab: () => {
    const { tabs, activeTabId } = get();
    if (!activeTabId) return null;
    return tabs.find((t) => t.id === activeTabId) ?? null;
  },
}));

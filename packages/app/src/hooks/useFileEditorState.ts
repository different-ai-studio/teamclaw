/**
 * useFileEditorState — file editor and tab state management extracted from App.tsx
 *
 * Handles:
 *  - Resizable panel widths (right panel)
 *  - Syncing selectedFile <-> TabsStore
 *  - Layout-mode-aware tab sync
 *  - Auto-switch right panel on layout mode change
 *  - Auto-open right panel when todos/diffs first appear
 */
import { useEffect, useRef, useCallback } from "react";
import { useWorkspaceStore } from "@/stores/workspace";
import { useSessionStore } from "@/stores/session";
import { useUIStore } from "@/stores/ui";
import { useTabsStore, selectActiveTab } from "@/stores/tabs";

// ─────────────────────────────────────────────────────────────────────────────
// Right panel auto-open when todos / diffs first arrive
// ─────────────────────────────────────────────────────────────────────────────

export function usePanelAutoOpen() {
  const sessionDiff = useSessionStore((s) => s.sessionDiff);
  const openPanel = useWorkspaceStore((s) => s.openPanel);
  const advancedMode = useUIStore((s) => s.advancedMode);
  const prevDiffCount = useRef(0);

  useEffect(() => {
    if (!advancedMode) {
      prevDiffCount.current = sessionDiff.length;
      return;
    }
    if (sessionDiff.length > 0 && prevDiffCount.current === 0) {
      openPanel("diff");
    }
    prevDiffCount.current = sessionDiff.length;
  }, [sessionDiff.length, openPanel, advancedMode]);
}

// ─────────────────────────────────────────────────────────────────────────────
// Auto-switch right panel on layout mode change
// ─────────────────────────────────────────────────────────────────────────────

export function useLayoutModePanelSync() {
  const layoutMode = useUIStore((s) => s.layoutMode);
  const setFileModeRightTab = useUIStore((s) => s.setFileModeRightTab);
  const closePanel = useWorkspaceStore((s) => s.closePanel);
  const prevLayoutMode = useRef(layoutMode);

  useEffect(() => {
    if (prevLayoutMode.current !== layoutMode) {
      if (layoutMode === "file") {
        setFileModeRightTab("shortcuts");
      } else {
        closePanel();
      }
      prevLayoutMode.current = layoutMode;
    }
  }, [layoutMode, setFileModeRightTab, closePanel]);
}

// ─────────────────────────────────────────────────────────────────────────────
// Sync selectedFile -> TabsStore (task mode)
// ─────────────────────────────────────────────────────────────────────────────

export function useFileTabSync() {
  const selectedFile = useWorkspaceStore((s) => s.selectedFile);
  const layoutMode = useUIStore((s) => s.layoutMode);

  // Open a tab whenever a file is selected (file mode: always; task mode: always)
  useEffect(() => {
    if (selectedFile && layoutMode === "file") {
      const filename = selectedFile.split("/").pop() || selectedFile;
      useTabsStore.getState().openTab({
        type: "file",
        target: selectedFile,
        label: filename,
      });
    }
  }, [selectedFile, layoutMode]);
}

// ─────────────────────────────────────────────────────────────────────────────
// Sync tab switch -> workspace selectFile
// ─────────────────────────────────────────────────────────────────────────────

export function useTabToFileSync() {
  const selectFile = useWorkspaceStore((s) => s.selectFile);
  const activeTab = useTabsStore(selectActiveTab);
  const prevActiveTabId = useRef<string | null>(activeTab?.id ?? null);

  useEffect(() => {
    const tabChanged = activeTab?.id !== prevActiveTabId.current;
    prevActiveTabId.current = activeTab?.id ?? null;
    if (tabChanged && activeTab?.type === "file") {
      selectFile(activeTab.target);
    }
  }, [activeTab?.id, activeTab?.type, activeTab?.target, selectFile]);
}

// ─────────────────────────────────────────────────────────────────────────────
// Resizable panel state
// ─────────────────────────────────────────────────────────────────────────────

import { useState } from "react";

const RIGHT_PANEL_MIN = 280;
const RIGHT_PANEL_MAX = 600;
const MAIN_SPLIT_LEFT_MIN = 360;
const MAIN_SPLIT_LEFT_MAX = 900;

export function useResizablePanels(options?: { mainSplitLeftMaxWidth?: number }) {
  const [rightPanelWidth, setRightPanelWidth] = useState(400);
  const [mainSplitLeftWidth, setMainSplitLeftWidth] = useState(560);
  const mainSplitLeftMaxWidth = options?.mainSplitLeftMaxWidth ?? MAIN_SPLIT_LEFT_MAX;

  const handleRightPanelResize = useCallback((delta: number) => {
    setRightPanelWidth((prev) =>
      Math.min(RIGHT_PANEL_MAX, Math.max(RIGHT_PANEL_MIN, prev - delta)),
    );
  }, []);

  const handleMainSplitResize = useCallback((delta: number) => {
    setMainSplitLeftWidth((prev) =>
      Math.min(mainSplitLeftMaxWidth, Math.max(MAIN_SPLIT_LEFT_MIN, prev + delta)),
    );
  }, [mainSplitLeftMaxWidth]);

  useEffect(() => {
    setMainSplitLeftWidth((prev) =>
      Math.min(mainSplitLeftMaxWidth, Math.max(MAIN_SPLIT_LEFT_MIN, prev)),
    );
  }, [mainSplitLeftMaxWidth]);

  return {
    rightPanelWidth,
    handleRightPanelResize,
    mainSplitLeftWidth,
    handleMainSplitResize,
  };
}

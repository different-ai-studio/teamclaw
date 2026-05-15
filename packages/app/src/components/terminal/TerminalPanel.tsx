import { useCallback, useEffect, useRef, useState } from "react";
import { useTerminalStore, type TerminalTab } from "@/stores/terminal-store";
import { TerminalTabBar } from "./TerminalTabBar";
import { XtermInstance } from "./XtermInstance";

interface Props {
  workspaceId: string;
  workspacePath: string;
  allowedRoots: string[];
}

const MIN_HEIGHT = 120;
const MIN_PARENT_RESERVED = 200;
const EMPTY_TABS: TerminalTab[] = [];
const AUTO_OPENING_WORKSPACES = new Set<string>();

export function TerminalPanel({ workspaceId, workspacePath, allowedRoots }: Props) {
  const tabs = useTerminalStore(s => s.tabsByWorkspace[workspaceId] ?? EMPTY_TABS);
  const activeId = useTerminalStore(s => s.activeTabByWorkspace[workspaceId] ?? null);
  const heightPx = useTerminalStore(
    s => s.panelHeightByWorkspace[workspaceId] ?? 240,
  );
  const setPanelHeight = useTerminalStore(s => s.setPanelHeight);
  const hydrate = useTerminalStore(s => s.hydrateForWorkspace);
  const openTerminal = useTerminalStore(s => s.openTerminal);
  const [dragging, setDragging] = useState(false);
  const startY = useRef(0);
  const startHeight = useRef(heightPx);
  const containerRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    void hydrate(workspaceId);
  }, [workspaceId, hydrate]);

  useEffect(() => {
    if (tabs.length !== 0 || AUTO_OPENING_WORKSPACES.has(workspaceId)) return;
    AUTO_OPENING_WORKSPACES.add(workspaceId);
    void openTerminal(workspaceId, { cwd: workspacePath, allowedRoots }).finally(() => {
      AUTO_OPENING_WORKSPACES.delete(workspaceId);
    });
  }, [tabs.length, workspaceId, workspacePath, allowedRoots, openTerminal]);

  const onDragMouseDown = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      setDragging(true);
      startY.current = e.clientY;
      startHeight.current = heightPx;
    },
    [heightPx],
  );

  useEffect(() => {
    if (!dragging) return;
    const onMove = (e: MouseEvent) => {
      const dy = startY.current - e.clientY;
      const parent = containerRef.current?.parentElement;
      const parentHeight = parent?.clientHeight ?? 800;
      const next = Math.max(
        MIN_HEIGHT,
        Math.min(parentHeight - MIN_PARENT_RESERVED, startHeight.current + dy),
      );
      setPanelHeight(workspaceId, next);
    };
    const onUp = () => setDragging(false);
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
    return () => {
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
    };
  }, [dragging, setPanelHeight, workspaceId]);

  return (
    <div
      ref={containerRef}
      style={{ height: heightPx }}
      className="flex shrink-0 flex-col border-t border-border bg-background"
    >
      <div
        role="separator"
        aria-orientation="horizontal"
        onMouseDown={onDragMouseDown}
        className="h-1 cursor-row-resize bg-transparent hover:bg-border-soft"
      />
      <TerminalTabBar
        workspaceId={workspaceId}
        workspacePath={workspacePath}
        allowedRoots={allowedRoots}
      />
      <div className="relative min-h-0 flex-1 overflow-hidden bg-paper">
        {tabs.map(tab => (
          <div
            key={tab.id}
            className="absolute inset-0"
            style={{ visibility: tab.id === activeId ? "visible" : "hidden" }}
          >
            <XtermInstance tabId={tab.id} active={tab.id === activeId} />
          </div>
        ))}
      </div>
    </div>
  );
}

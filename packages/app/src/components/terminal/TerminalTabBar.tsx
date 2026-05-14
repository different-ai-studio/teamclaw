import { Plus, X } from "lucide-react";
import { useTranslation } from "react-i18next";
import { cn } from "@/lib/utils";
import { useTerminalStore } from "@/stores/terminal-store";

interface Props {
  workspaceId: string;
  workspacePath: string;
  allowedRoots: string[];
}

export function TerminalTabBar({ workspaceId, workspacePath, allowedRoots }: Props) {
  const { t } = useTranslation();
  const tabs = useTerminalStore(s => s.tabsByWorkspace[workspaceId] ?? []);
  const activeId = useTerminalStore(s => s.activeTabByWorkspace[workspaceId] ?? null);
  const openTerminal = useTerminalStore(s => s.openTerminal);
  const closeTerminal = useTerminalStore(s => s.closeTerminal);
  const setActiveTab = useTerminalStore(s => s.setActiveTab);

  return (
    <div className="flex items-center gap-1 border-b border-border bg-panel px-2 py-1">
      <span className="mr-2 text-[11px] uppercase tracking-wide text-faint">
        {t("terminal.label", "Terminal")}
      </span>
      {tabs.map(tab => (
        <button
          key={tab.id}
          onClick={() => setActiveTab(workspaceId, tab.id)}
          className={cn(
            "group flex items-center gap-1 rounded px-2 py-0.5 text-[12px]",
            tab.id === activeId
              ? "bg-selected text-foreground"
              : "text-muted-foreground hover:bg-muted hover:text-foreground",
            tab.status === "exited" && "italic opacity-60",
          )}
        >
          <span className="font-mono">{tab.title}</span>
          {tab.status === "exited" && tab.exitCode !== undefined && (
            <span className="text-[10px] text-faint">({tab.exitCode})</span>
          )}
          <span
            role="button"
            tabIndex={-1}
            onClick={e => {
              e.stopPropagation();
              void closeTerminal(tab.id);
            }}
            className="ml-1 rounded p-0.5 opacity-0 transition-opacity hover:bg-background hover:text-foreground group-hover:opacity-100"
            title={t("terminal.closeTab", "Close terminal")}
          >
            <X className="h-3 w-3" />
          </span>
        </button>
      ))}
      <button
        onClick={() =>
          openTerminal(workspaceId, { cwd: workspacePath, allowedRoots })
        }
        className="ml-1 rounded p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
        title={t("terminal.newTab", "New terminal")}
      >
        <Plus className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}

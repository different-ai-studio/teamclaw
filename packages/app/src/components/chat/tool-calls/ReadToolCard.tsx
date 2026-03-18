import { useCallback } from "react";
import { Eye, FolderOpen } from "lucide-react";
import { cn } from "@/lib/utils";
import { ToolCall } from "@/stores/session";
import { useWorkspaceStore } from "@/stores/workspace";
import { PermissionApprovalBar } from "./PermissionApprovalBar";
import { statusConfig, extractFilePath, getFileName } from "./tool-call-utils";

export function ReadToolCard({ toolCall }: { toolCall: ToolCall }) {
  const args = toolCall.arguments as Record<string, unknown>;
  const filePath = extractFilePath(args);
  const config = statusConfig[toolCall.status];
  const StatusIcon = config.icon;
  const displayName = filePath ? getFileName(filePath) : "file";
  const selectFile = useWorkspaceStore((s) => s.selectFile);
  const workspacePath = useWorkspaceStore((s) => s.workspacePath);

  const hasPendingPermission =
    toolCall.status === "calling" &&
    toolCall.permission?.decision === "pending";

  const handleClick = useCallback(() => {
    if (!filePath) return;
    const fullPath =
      filePath.startsWith("/") ? filePath : `${workspacePath}/${filePath}`;
    selectFile(fullPath);
  }, [filePath, workspacePath, selectFile]);

  return (
    <div>
      <div
        className="flex items-center gap-2 px-2 py-1 text-xs text-muted-foreground cursor-pointer hover:text-foreground/80 transition-colors select-none"
        onClick={handleClick}
        title={filePath || "Open file"}
      >
        <Eye size={12} className="text-muted-foreground/60 shrink-0" />
        <span className="font-mono text-[11px] truncate max-w-[300px]">
          {displayName}
        </span>
        {hasPendingPermission && (
          <span className="text-[10px] px-1.5 py-0.5 rounded bg-muted text-muted-foreground font-medium flex items-center gap-1 border border-border">
            <FolderOpen size={10} />
            {toolCall.permission?.permission === "external_directory"
              ? "External path"
              : "Approval needed"}
          </span>
        )}
        <StatusIcon
          size={12}
          className={cn(
            "shrink-0",
            config.animate && "animate-spin",
            config.textColor,
          )}
        />
      </div>
      <PermissionApprovalBar toolCall={toolCall} />
    </div>
  );
}

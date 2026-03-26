import { useCallback, useMemo } from "react";
import { Eye, FolderOpen } from "lucide-react";
import { cn } from "@/lib/utils";
import { ToolCall } from "@/stores/session";
import { useWorkspaceStore } from "@/stores/workspace";
import { PermissionApprovalBar } from "./PermissionApprovalBar";
import { statusConfig, extractFilePath, getFileName } from "./tool-call-utils";
import {
  resolveWorkspaceRelativePath,
  useToolCallFileOnDisk,
} from "@/hooks/useToolCallFileOnDisk";

export function ReadToolCard({ toolCall }: { toolCall: ToolCall }) {
  const args = toolCall.arguments as Record<string, unknown>;
  const filePath = extractFilePath(args);
  const config = statusConfig[toolCall.status];
  const StatusIcon = config.icon;
  const displayName = filePath ? getFileName(filePath) : "file";
  const selectFile = useWorkspaceStore((s) => s.selectFile);
  const workspacePath = useWorkspaceStore((s) => s.workspacePath);

  const fullPath = useMemo(
    () => resolveWorkspaceRelativePath(filePath, workspacePath),
    [filePath, workspacePath],
  );
  const shouldVerifyFileOnDisk =
    Boolean(fullPath) &&
    (toolCall.status === "completed" || toolCall.status === "failed");
  const fileOnDisk = useToolCallFileOnDisk(fullPath, shouldVerifyFileOnDisk);
  const fileMissingOnDisk = fileOnDisk === false;

  const hasPendingPermission =
    toolCall.status === "calling" &&
    toolCall.permission?.decision === "pending";

  const canOpenFile =
    Boolean(filePath) && Boolean(fullPath) && !fileMissingOnDisk;

  const handleClick = useCallback(() => {
    if (!canOpenFile || !fullPath) return;
    selectFile(fullPath);
  }, [canOpenFile, fullPath, selectFile]);

  return (
    <div>
      <div
        className={cn(
          "flex items-center gap-2 px-2 py-1 text-xs text-muted-foreground transition-colors select-none",
          canOpenFile
            ? "cursor-pointer hover:text-foreground/80"
            : "cursor-default opacity-80",
        )}
        onClick={canOpenFile ? handleClick : undefined}
        title={filePath || "Open file"}
        role={canOpenFile ? "button" : undefined}
      >
        <Eye size={12} className="text-muted-foreground/60 shrink-0" />
        <span
          className={cn(
            "font-mono text-[11px] truncate max-w-[300px]",
            fileMissingOnDisk && "line-through",
          )}
        >
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

import React, { useState, useEffect, useCallback, useMemo } from "react";
import {
  ChevronRight,
  Loader2,
  FilePlus,
  Copy,
  CheckCheck,
  AlertTriangle,
  CheckCircle2,
} from "lucide-react";
import { cn, copyToClipboard } from "@/lib/utils";
import { ToolCall, useSessionStore } from "@/stores/session";
import { useWorkspaceStore } from "@/stores/workspace";
import { PermissionApprovalBar } from "./PermissionApprovalBar";
import {
  statusConfig,
  extractFilePath,
  getFileExtension,
  getLanguageName,
  getFileName,
  useToolCallTimeout,
} from "./tool-call-utils";
import { parseSingleFileDiff, type DiffLine } from "@/components/diff/diff-ast";
import { ToolCallDiffBody } from "./ToolCallDiffBody";
import {
  resolveWorkspaceRelativePath,
  useToolCallFileOnDisk,
} from "@/hooks/useToolCallFileOnDisk";

// Generate unified diff for new file (empty before)
function generateNewFileDiff(content: string, filePath: string): string {
  const lines: string[] = [];
  lines.push(`diff --git a/${filePath} b/${filePath}`);
  lines.push('new file mode 100644');
  lines.push(`--- /dev/null`);
  lines.push(`+++ b/${filePath}`);
  
  const contentLines = content.split('\n');
  lines.push(`@@ -0,0 +1,${contentLines.length} @@`);
  
  for (const line of contentLines) {
    lines.push(`+${line}`);
  }
  
  return lines.join('\n');
}

export function WriteToolCard({ toolCall }: { toolCall: ToolCall }) {
  const [isExpanded, setIsExpanded] = useState(true);
  const [copied, setCopied] = useState(false);
  const isTimedOut = useToolCallTimeout(toolCall);
  const forceComplete = useSessionStore((s) => s.forceCompleteToolCall);
  const selectFile = useWorkspaceStore((s) => s.selectFile);
  const workspacePath = useWorkspaceStore((s) => s.workspacePath);

  const args = toolCall.arguments as Record<string, unknown>;
  const filePath = extractFilePath(args);

  // Debug: log arguments to find the actual structure
  useEffect(() => {
    if (!filePath && args && Object.keys(args).length > 0) {
      console.log("[WriteToolCard] args keys:", Object.keys(args), "full:", args);
    }
  }, [filePath, args]);

  // Content can come from arguments (when complete) or from result (during streaming)
  const argsContent = String(args?.contents || args?.content || "");
  const streamingContent =
    typeof toolCall.result === "string" ? toolCall.result : "";
  const content = argsContent || streamingContent;
  const ext = getFileExtension(filePath);
  const langName = getLanguageName(ext);
  const config = statusConfig[toolCall.status];
  const StatusIcon = config.icon;

  // Generate unified diff for new file (shows as all additions)
  const fullPath = useMemo(
    () => resolveWorkspaceRelativePath(filePath, workspacePath),
    [filePath, workspacePath],
  );
  const shouldVerifyFileOnDisk =
    Boolean(fullPath) && toolCall.status === "completed";
  const fileOnDisk = useToolCallFileOnDisk(fullPath, shouldVerifyFileOnDisk);
  const fileMissingOnDisk = fileOnDisk === false;

  const diffData = useMemo(() => {
    if (!content) return null;
    try {
      const diffText = generateNewFileDiff(content, filePath || "file");
      const parsed = parseSingleFileDiff(diffText, filePath || "file");
      if (!parsed) return null;

      // Merge all hunks into a single list of lines
      const allLines: DiffLine[] = [];
      for (const hunk of parsed.hunks) {
        allLines.push(...hunk.lines);
      }

      return {
        lines: allLines,
        additions: parsed.addedCount,
      };
    } catch (error) {
      console.error("[WriteToolCard] Failed to generate diff:", error);
      return null;
    }
  }, [content, filePath]);

  const handleCopy = async () => {
    await copyToClipboard(content);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const handleForceComplete = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation();
      forceComplete(toolCall.id);
    },
    [forceComplete, toolCall.id],
  );

  const canOpenFile =
    Boolean(filePath) &&
    Boolean(fullPath) &&
    toolCall.status !== "failed" &&
    !fileMissingOnDisk;

  const handleOpenFile = useCallback(() => {
    if (!canOpenFile || !fullPath) return;
    selectFile(fullPath);
  }, [canOpenFile, fullPath, selectFile]);

  const handleToggleExpand = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    setIsExpanded((prev) => !prev);
  }, []);

  return (
    <div className="rounded-lg border border-border bg-muted/30 overflow-hidden transition-all duration-200">
      {/* Header: click chevron to toggle, click rest to open file */}
      <div
        className={cn(
          "flex items-center gap-2 px-3 py-2 bg-muted/50 transition-colors select-none hover:bg-muted/70",
          canOpenFile ? "cursor-pointer" : "",
        )}
        onClick={canOpenFile ? handleOpenFile : handleToggleExpand}
      >
        <ChevronRight
          size={14}
          className={cn(
            "text-muted-foreground transition-transform duration-200 shrink-0",
            isExpanded && "rotate-90",
          )}
          onClick={handleToggleExpand}
        />
        <FilePlus size={14} className="text-muted-foreground shrink-0" />
        {filePath && (
          <span
            className={cn(
              "text-xs truncate flex-1 font-mono",
              canOpenFile
                ? "text-foreground"
                : "text-muted-foreground line-through",
            )}
            title={filePath}
          >
            {getFileName(filePath)}
          </span>
        )}
        {!filePath && <span className="flex-1" />}
        <span className="text-[10px] text-muted-foreground">{langName}</span>
        {diffData && diffData.additions > 0 && (
          <span className="text-[10px] text-green-600 dark:text-green-500">+{diffData.additions}</span>
        )}
        {toolCall.duration && (
          <span className="text-[10px] text-muted-foreground/70">
            {toolCall.duration < 1000
              ? `${toolCall.duration}ms`
              : `${(toolCall.duration / 1000).toFixed(1)}s`}
          </span>
        )}
        <button
          onClick={handleCopy}
          className="p-1 rounded hover:bg-background transition-colors"
          title="Copy content"
        >
          {copied ? (
            <CheckCheck size={12} className="text-foreground" />
          ) : (
            <Copy size={12} className="text-muted-foreground" />
          )}
        </button>
        {isTimedOut ? (
          <button
            onClick={handleForceComplete}
            className="flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] bg-muted hover:bg-muted/80 text-foreground border border-border transition-colors"
            title="Tool call timed out - click to mark as done"
          >
            <AlertTriangle size={10} />
            <span>Timed out</span>
            <CheckCircle2 size={10} />
          </button>
        ) : (
          <StatusIcon
            size={14}
            className={cn(config.textColor, config.animate && "animate-spin")}
          />
        )}
      </div>

      {isExpanded && diffData && diffData.lines.length > 0 && (
        <ToolCallDiffBody lines={diffData.lines} />
      )}

      {/* Loading placeholder when no content yet */}
      {isExpanded && !content && toolCall.status === "calling" && (
        <div className="p-3 flex items-center gap-2 text-xs text-muted-foreground">
          <Loader2 size={12} className="animate-spin" />
          <span>Writing file...</span>
        </div>
      )}

      {/* Fallback: show error if diff generation failed but we have content */}
      {isExpanded && content && !diffData && (
        <div className="p-3 text-xs text-muted-foreground italic">
          Unable to generate diff view
        </div>
      )}

      <PermissionApprovalBar toolCall={toolCall} />
    </div>
  );
}

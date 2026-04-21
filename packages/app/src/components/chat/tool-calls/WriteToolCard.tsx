import { useEffect, useCallback, useMemo } from "react";
import {
  Loader2,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { ToolCall } from "@/stores/session";
import { useWorkspaceStore } from "@/stores/workspace";
import {
  extractFilePath,
  getFileName,
} from "./tool-call-utils";
import { parseSingleFileDiff, type DiffLine } from "@/components/diff/diff-ast";
import { ToolCallDiffBody } from "./ToolCallDiffBody";
import {
  resolveWorkspaceRelativePath,
  useToolCallFileOnDisk,
} from "@/hooks/useToolCallFileOnDisk";

function StatusGlyph({ status }: { status: ToolCall["status"] }) {
  return (
    <span
      className={cn(
        "text-[13px]",
        status === "failed"
          ? "text-red-600 dark:text-red-400"
          : status === "completed"
            ? "text-green-600 dark:text-green-400"
            : "text-muted-foreground",
      )}
    >
      {status === "failed" ? "✕" : status === "completed" ? "✓" : "●"}
    </span>
  );
}

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

  const canOpenFile =
    Boolean(filePath) &&
    Boolean(fullPath) &&
    toolCall.status !== "failed" &&
    !fileMissingOnDisk;

  const handleOpenFile = useCallback(() => {
    if (!canOpenFile || !fullPath) return;
    selectFile(fullPath);
  }, [canOpenFile, fullPath, selectFile]);

  return (
    <div
      data-testid="tool-card-write"
      className="overflow-hidden rounded-[14px] border border-[#e7edf4] bg-[#fbfcfe] transition-all duration-200 dark:border-border dark:bg-card"
    >
      <div
        className={cn(
          "flex items-center gap-2 border-b border-[#eef2f5] px-[14px] py-3 select-none dark:border-border/60 dark:bg-transparent",
          canOpenFile ? "cursor-pointer" : "",
        )}
        onClick={canOpenFile ? handleOpenFile : undefined}
      >
        <span className="text-[13px] text-muted-foreground shrink-0">+</span>
        <span className="text-sm font-semibold text-foreground shrink-0">Write</span>
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
        {diffData && diffData.additions > 0 && (
          <span className="text-[10px] text-green-600 dark:text-green-500">+{diffData.additions}</span>
        )}
        <StatusGlyph status={toolCall.status} />
      </div>

      {diffData && diffData.lines.length > 0 && (
        <div className="px-[14px] pb-3 pt-3">
          <div className="overflow-hidden rounded-[10px] border border-[#eef2f5] bg-[#fcfdff] dark:border-border/60 dark:bg-background/40">
            <ToolCallDiffBody lines={diffData.lines} variant="snippet" previewLineCount={3} />
          </div>
        </div>
      )}

      {!content && toolCall.status === "calling" && (
        <div className="border-t border-border/50 p-3 flex items-center gap-2 text-xs text-muted-foreground">
          <Loader2 size={12} className="animate-spin" />
          <span>Writing file...</span>
        </div>
      )}

      {content && !diffData && (
        <div className="border-t border-border/50 p-3 text-xs text-muted-foreground italic">
          Unable to generate diff view
        </div>
      )}

    </div>
  );
}

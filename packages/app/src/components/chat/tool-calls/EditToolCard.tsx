import React, { useState, useCallback, useMemo } from "react";
import {
  ChevronRight,
  FileEdit,
  Copy,
  CheckCheck,
} from "lucide-react";
import { cn, copyToClipboard } from "@/lib/utils";
import { ToolCall } from "@/stores/session";
import { useWorkspaceStore } from "@/stores/workspace";
import { PermissionApprovalBar } from "./PermissionApprovalBar";
import {
  statusConfig,
  extractFilePath,
  getFileExtension,
  getLanguageName,
  getFileName,
} from "./tool-call-utils";
import { parseSingleFileDiff, type DiffLine } from "@/components/diff/diff-ast";

// Generate unified diff from before/after strings
function generateUnifiedDiff(before: string, after: string, filePath: string): string {
  const oldLines = before.split('\n');
  const newLines = after.split('\n');

  const lines: string[] = [];
  lines.push(`diff --git a/${filePath} b/${filePath}`);
  lines.push(`--- a/${filePath}`);
  lines.push(`+++ b/${filePath}`);

  let hunkStart = -1;
  let hunkOldStart = 0;
  let hunkNewStart = 0;
  const hunkLines: string[] = [];

  const flushHunk = () => {
    if (hunkLines.length > 0) {
      const oldCount = hunkLines.filter(l => l.startsWith('-') || l.startsWith(' ')).length;
      const newCount = hunkLines.filter(l => l.startsWith('+') || l.startsWith(' ')).length;
      lines.push(`@@ -${hunkOldStart + 1},${oldCount} +${hunkNewStart + 1},${newCount} @@`);
      lines.push(...hunkLines);
      hunkLines.length = 0;
      hunkStart = -1;
    }
  };

  let oi = 0;
  let ni = 0;

  while (oi < oldLines.length || ni < newLines.length) {
    if (oi < oldLines.length && ni < newLines.length && oldLines[oi] === newLines[ni]) {
      if (hunkStart >= 0) {
        hunkLines.push(` ${oldLines[oi]}`);
        const contextCount = hunkLines.slice().reverse().findIndex(l => !l.startsWith(' '));
        if (contextCount >= 3) {
          hunkLines.splice(hunkLines.length - (contextCount - 3));
          flushHunk();
        }
      }
      oi++;
      ni++;
    } else {
      if (hunkStart < 0) {
        hunkStart = oi;
        hunkOldStart = Math.max(0, oi - 3);
        hunkNewStart = Math.max(0, ni - 3);
        for (let c = Math.max(0, oi - 3); c < oi; c++) {
          if (c < oldLines.length) {
            hunkLines.push(` ${oldLines[c]}`);
          }
        }
      }

      if (oi < oldLines.length && (ni >= newLines.length || oldLines[oi] !== newLines[ni])) {
        const nextInNew = newLines.indexOf(oldLines[oi], ni);
        const nextInOld = ni < newLines.length ? oldLines.indexOf(newLines[ni], oi) : -1;

        if (nextInNew >= 0 && (nextInOld < 0 || nextInNew - ni <= nextInOld - oi)) {
          while (ni < nextInNew) {
            hunkLines.push(`+${newLines[ni]}`);
            ni++;
          }
        } else if (nextInOld >= 0) {
          while (oi < nextInOld) {
            hunkLines.push(`-${oldLines[oi]}`);
            oi++;
          }
        } else {
          if (oi < oldLines.length) {
            hunkLines.push(`-${oldLines[oi]}`);
            oi++;
          }
          if (ni < newLines.length) {
            hunkLines.push(`+${newLines[ni]}`);
            ni++;
          }
        }
      } else {
        if (ni < newLines.length) {
          hunkLines.push(`+${newLines[ni]}`);
          ni++;
        }
        if (oi < oldLines.length && oldLines[oi] !== newLines[ni - 1]) {
          hunkLines.push(`-${oldLines[oi]}`);
          oi++;
        }
      }
    }
  }

  flushHunk();
  return lines.join('\n');
}

export function EditToolCard({ toolCall }: { toolCall: ToolCall }) {
  const [isExpanded, setIsExpanded] = useState(true);
  const [copied, setCopied] = useState(false);
  const selectFile = useWorkspaceStore((s) => s.selectFile);
  const workspacePath = useWorkspaceStore((s) => s.workspacePath);

  const args = toolCall.arguments as Record<string, unknown>;
  const filePath = extractFilePath(args);
  const oldStr = String(args?.old_string || args?.oldString || "");
  const newStr = String(args?.new_string || args?.newString || "");
  const ext = getFileExtension(filePath);
  const langName = getLanguageName(ext);
  const config = statusConfig[toolCall.status];
  const StatusIcon = config.icon;

  // Generate unified diff and parse into structured format
  const diffData = useMemo(() => {
    if (!oldStr && !newStr) return null;
    try {
      const diffText = generateUnifiedDiff(oldStr, newStr, filePath || "file");
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
        deletions: parsed.removedCount,
      };
    } catch (error) {
      console.error("[EditToolCard] Failed to generate diff:", error);
      return null;
    }
  }, [oldStr, newStr, filePath]);

  const handleCopy = async () => {
    await copyToClipboard(newStr);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const handleOpenFile = useCallback(() => {
    if (!filePath) return;
    const fullPath =
      filePath.startsWith("/") ? filePath : `${workspacePath}/${filePath}`;
    selectFile(fullPath);
  }, [filePath, workspacePath, selectFile]);

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
          filePath ? "cursor-pointer" : "",
        )}
        onClick={filePath ? handleOpenFile : handleToggleExpand}
      >
        <ChevronRight
          size={14}
          className={cn(
            "text-muted-foreground transition-transform duration-200 shrink-0",
            isExpanded && "rotate-90",
          )}
          onClick={handleToggleExpand}
        />
        <FileEdit size={14} className="text-muted-foreground shrink-0" />
        {filePath && (
          <span
            className="text-xs text-foreground truncate flex-1 cursor-pointer font-mono"
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
        {diffData && diffData.deletions > 0 && (
          <span className="text-[10px] text-red-600 dark:text-red-500">−{diffData.deletions}</span>
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
          title="Copy new content"
        >
          {copied ? (
            <CheckCheck size={12} className="text-foreground" />
          ) : (
            <Copy size={12} className="text-muted-foreground" />
          )}
        </button>
        <StatusIcon
          size={14}
          className={cn(config.textColor, config.animate && "animate-spin")}
        />
      </div>

      {/* Unified diff view - all lines merged without hunk grouping */}
      {isExpanded && diffData && diffData.lines.length > 0 && (
        <div className="border-t border-border bg-background max-h-[400px] overflow-y-auto">
          {diffData.lines.map((line, index) => (
            <div
              key={index}
              className={cn(
                "flex font-mono text-[11px] leading-5",
                line.type === "added" && "bg-green-500/5 dark:bg-green-500/10",
                line.type === "removed" && "bg-red-500/5 dark:bg-red-500/10",
                line.type === "context" && "bg-transparent",
              )}
            >
              {/* Old line number */}
              <span className="w-10 text-right pr-2 select-none text-muted-foreground/40 shrink-0 text-[10px]">
                {line.oldLineNumber ?? ""}
              </span>
              {/* New line number */}
              <span className="w-10 text-right pr-2 select-none text-muted-foreground/40 shrink-0 text-[10px]">
                {line.newLineNumber ?? ""}
              </span>
              {/* Change indicator */}
              <span
                className={cn(
                  "w-4 text-center select-none shrink-0 text-[10px]",
                  line.type === "added" && "text-green-600 dark:text-green-500",
                  line.type === "removed" && "text-red-600 dark:text-red-500",
                  line.type === "context" && "text-muted-foreground/30",
                )}
              >
                {line.type === "added" ? "+" : line.type === "removed" ? "−" : " "}
              </span>
              {/* Content */}
              <span className="flex-1 whitespace-pre-wrap break-all pl-1 text-foreground/90">
                {line.content}
              </span>
            </div>
          ))}
        </div>
      )}

      {/* Fallback: show error if diff generation failed but we have content */}
      {isExpanded && (oldStr || newStr) && !diffData && (
        <div className="p-3 text-xs text-muted-foreground italic">
          Unable to generate diff view
        </div>
      )}

      <PermissionApprovalBar toolCall={toolCall} />
    </div>
  );
}

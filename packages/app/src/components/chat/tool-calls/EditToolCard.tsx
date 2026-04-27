import { useMemo, useCallback } from "react";
import { useTranslation } from "react-i18next";
import { Trash2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { ToolCall } from "@/stores/session";
import { useWorkspaceStore } from "@/stores/workspace";
import {
  extractFilePath,
  extractPatchTextFromToolArgs,
  parseDeleteOnlyPatch,
  getFileName,
} from "./tool-call-utils";
import { parseSingleFileDiff, type DiffLine } from "@/components/diff/diff-ast";
import { tryParseToolPatchForUI } from "@/components/diff/parse-tool-patch";
import { ToolCallDiffBody } from "./ToolCallDiffBody";
import {
  resolveWorkspaceRelativePath,
  useToolCallFileOnDisk,
} from "@/hooks/useToolCallFileOnDisk";
import { ToolCallStatusGlyph } from "./ToolCallStatusGlyph";

function generateUnifiedDiff(before: string, after: string, filePath: string): string {
  const oldLines = before.split("\n");
  const newLines = after.split("\n");
  const lines: string[] = [];
  lines.push(`diff --git a/${filePath} b/${filePath}`);
  lines.push(`--- a/${filePath}`);
  lines.push(`+++ b/${filePath}`);
  lines.push(`@@ -1,${oldLines.length} +1,${newLines.length} @@`);

  oldLines.forEach((line) => lines.push(`-${line}`));
  newLines.forEach((line) => lines.push(`+${line}`));
  return lines.join("\n");
}

export function EditToolCard({ toolCall }: { toolCall: ToolCall }) {
  const { t } = useTranslation();
  const selectFile = useWorkspaceStore((s) => s.selectFile);
  const workspacePath = useWorkspaceStore((s) => s.workspacePath);

  const args = toolCall.arguments as Record<string, unknown>;
  const filePath = extractFilePath(args);
  const patchText = extractPatchTextFromToolArgs(args);
  const oldStr = String(args?.old_string || args?.oldString || "");
  const newStr = String(args?.new_string || args?.newString || "");

  const deletedFiles = useMemo(
    () => (patchText ? parseDeleteOnlyPatch(patchText) : null),
    [patchText],
  );

  const diffData = useMemo(() => {
    try {
      if (oldStr || newStr) {
        const diffText = generateUnifiedDiff(oldStr, newStr, filePath || "file");
        const parsed = parseSingleFileDiff(diffText, filePath || "file");
        if (!parsed) return null;

        const allLines: DiffLine[] = [];
        for (const hunk of parsed.hunks) {
          allLines.push(...hunk.lines);
        }

        return {
          lines: allLines,
          additions: parsed.addedCount,
          deletions: parsed.removedCount,
          headerPath: filePath || "file",
        };
      }

      if (patchText) {
        const parsed = tryParseToolPatchForUI(patchText, filePath);
        if (!parsed || parsed.lines.length === 0) return null;

        return {
          lines: parsed.lines,
          additions: parsed.additions,
          deletions: parsed.deletions,
          headerPath: filePath || parsed.filePath || "file",
        };
      }
    } catch {
      return null;
    }
    return null;
  }, [oldStr, newStr, filePath, patchText]);

  const headerPath = diffData?.headerPath ?? filePath;
  const pathForDisk =
    headerPath && headerPath !== "file" ? headerPath : filePath || null;
  const fullPath = useMemo(
    () => resolveWorkspaceRelativePath(pathForDisk, workspacePath),
    [pathForDisk, workspacePath],
  );
  const shouldVerifyFileOnDisk =
    Boolean(fullPath) && toolCall.status === "completed";
  const fileOnDisk = useToolCallFileOnDisk(fullPath, shouldVerifyFileOnDisk);
  const fileMissingOnDisk = fileOnDisk === false;

  const canOpenFile =
    Boolean(headerPath) &&
    Boolean(fullPath) &&
    toolCall.status !== "failed" &&
    !fileMissingOnDisk;

  const handleOpenFile = useCallback(() => {
    if (!canOpenFile || !fullPath) return;
    selectFile(fullPath);
  }, [canOpenFile, fullPath, selectFile]);

  if (deletedFiles) {
    return (
      <div
        data-testid="tool-card-edit"
        className="overflow-hidden rounded-[14px] border border-[#e7edf4] bg-[#fbfcfe] transition-all duration-200 dark:border-border dark:bg-card"
      >
        <div className="flex items-center gap-2 border-b border-[#eef2f5] px-[14px] py-3 dark:border-border/60">
          <Trash2 size={14} className="text-muted-foreground shrink-0" />
          <span className="text-sm font-semibold text-foreground">
            {t("chat.toolCall.edit.title", "Edit")}
          </span>
          <span className="text-xs text-muted-foreground">
            {t("chat.toolCall.edit.deletedFiles", "Deleted {{count}} files", {
              count: deletedFiles.length,
            })}
          </span>
          <span className="flex-1" />
          <ToolCallStatusGlyph status={toolCall.status} />
        </div>
        <div className="border-t border-border/50 px-3 pb-2 pt-2 space-y-0.5">
          {deletedFiles.map((f, i) => (
            <div key={i} className="flex items-center gap-2 py-0.5 text-xs text-muted-foreground">
              <span className="text-red-500 dark:text-red-400 text-[10px]">D</span>
              <span className="font-mono truncate line-through">{getFileName(f)}</span>
            </div>
          ))}
        </div>
      </div>
    );
  }

  return (
    <div
      data-testid="tool-card-edit"
      className="overflow-hidden rounded-[14px] border border-[#e7edf4] bg-[#fbfcfe] transition-all duration-200 dark:border-border dark:bg-card"
    >
      <div
        className={cn(
          "flex items-center gap-2 border-b border-[#eef2f5] px-[14px] py-3 select-none dark:border-border/60",
          canOpenFile ? "cursor-pointer" : "",
        )}
        onClick={canOpenFile ? handleOpenFile : undefined}
      >
        <span className="text-[13px] text-muted-foreground shrink-0">~</span>
        <span className="text-sm font-semibold text-foreground shrink-0">
          {t("chat.toolCall.edit.title", "Edit")}
        </span>
        {headerPath ? (
          <span
            className={cn(
              "text-xs truncate flex-1 font-mono",
              canOpenFile
                ? "text-foreground"
                : "text-muted-foreground line-through",
            )}
            title={headerPath}
          >
            {getFileName(headerPath)}
          </span>
        ) : (
          <span className="flex-1" />
        )}
        {diffData ? (
          <span className="text-[10px] text-muted-foreground">
            {diffData.deletions > 0 ? `-${diffData.deletions}` : ""}
            {diffData.deletions > 0 && diffData.additions > 0 ? " " : ""}
            {diffData.additions > 0 ? `+${diffData.additions}` : ""}
          </span>
        ) : null}
        <ToolCallStatusGlyph status={toolCall.status} />
      </div>

      {diffData?.lines.length ? (
        <div className="px-[14px] pb-3 pt-3">
          <div className="overflow-hidden rounded-[10px] border border-[#eef2f5] bg-[#fcfdff] dark:border-border/60 dark:bg-background/40">
            <ToolCallDiffBody lines={diffData.lines} variant="snippet" />
          </div>
        </div>
      ) : patchText ? (
        <div className="border-t border-border/50 p-3 text-xs text-muted-foreground italic">
          {t("chat.toolCall.diff.unavailable", "Unable to generate diff view")}
        </div>
      ) : null}
    </div>
  );
}

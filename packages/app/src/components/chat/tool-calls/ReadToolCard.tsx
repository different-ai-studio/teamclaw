import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { cn } from "@/lib/utils";
import { ToolCall } from "@/stores/session";
import { extractFilePath, getFileName } from "./tool-call-utils";
import { useToolCallFileOnDisk } from "@/hooks/useToolCallFileOnDisk";

export function ReadToolCard({ toolCall }: { toolCall: ToolCall }) {
  const { t } = useTranslation();
  const args = toolCall.arguments as Record<string, unknown>;
  const filePath = extractFilePath(args);
  const displayName = filePath ? getFileName(filePath) : t("chat.toolCall.read.defaultFile", "file");
  const fullPath = useMemo(() => filePath, [filePath]);
  const shouldVerifyFileOnDisk =
    Boolean(fullPath) &&
    (toolCall.status === "completed" || toolCall.status === "failed");
  const fileOnDisk = useToolCallFileOnDisk(fullPath, shouldVerifyFileOnDisk);
  const fileMissingOnDisk = fileOnDisk === false;

  const sizeText = useMemo(() => {
    if (typeof toolCall.result !== "string" || !toolCall.result.length) return null;
    const bytes = new TextEncoder().encode(toolCall.result).length;
    if (bytes < 1024) return `${bytes} B`;
    return `${(bytes / 1024).toFixed(1)} KB`;
  }, [toolCall.result]);

  return (
    <div
      data-testid="tool-row-read"
      className="grid grid-cols-[minmax(0,1fr)] items-center px-[10px] py-[4px]"
    >
      <div className="grid grid-cols-[minmax(0,1fr)] items-center select-none">
        <span className="min-w-0 text-[12px] text-[#475569] dark:text-slate-400">
          <strong className="font-medium text-foreground/80">
            {t("chat.toolCall.read.title", "Read")}
          </strong>
          <span
            className={cn(
              "ml-1 font-mono text-foreground/70",
              fileMissingOnDisk && "line-through",
            )}
          >
            {displayName}
          </span>
            {sizeText ? (
              <span className="ml-1 text-[#94a3b8] dark:text-muted-foreground">· {sizeText}</span>
            ) : null}
          </span>
      </div>
    </div>
  );
}

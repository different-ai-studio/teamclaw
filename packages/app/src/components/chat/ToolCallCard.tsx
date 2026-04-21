import React, { useState, useCallback } from "react";
import {
  ChevronRight,
  AlertTriangle,
  CheckCircle2,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { ToolCall, useSessionStore } from "@/stores/session";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { QuestionCard } from "./QuestionCard";
import { getCommandText, getToolCallOutputText } from "@/lib/terminal-interaction";

// Import sub-cards and utilities from tool-calls/
import { WriteToolCard } from "./tool-calls/WriteToolCard";
import { EditToolCard } from "./tool-calls/EditToolCard";
import { ReadToolCard } from "./tool-calls/ReadToolCard";
import { RoleLoadToolCard } from "./tool-calls/RoleLoadToolCard";
import { RoleSkillToolCard, SkillToolCard, TaskToolCard } from "./tool-calls/TaskToolCard";
import {
  statusConfig,
  getToolIcon,
  isQuestionTool,
  isWriteTool,
  isEditTool,
  isReadTool,
  isTaskTool,
  isSkillTool,
  isRoleSkillTool,
  isRoleLoadTool,
  isCommandTool,
  isTodoTool,
  isCommandToolLikelyWaitingForInput,
  formatToolName,
  useToolCallTimeout,
} from "./tool-calls/tool-call-utils";

interface ToolCallCardProps {
  toolCall: ToolCall;
  onOpenDetail?: (
    type: "search" | "file" | "terminal" | "mcp",
    data: unknown,
  ) => void;
}

export const ToolCallCard = React.memo(function ToolCallCard({ toolCall, onOpenDetail }: ToolCallCardProps) {
  const [expanded, setExpanded] = useState(false);
  const isTimedOut = useToolCallTimeout(toolCall);
  const forceComplete = useSessionStore((s) => s.forceCompleteToolCall);
  const config = statusConfig[toolCall.status];
  const StatusIcon = config.icon;
  const ToolIcon = getToolIcon(toolCall.name);
  const isCommand = isCommandTool(toolCall.name);
  const isWaitingForInput = isCommandToolLikelyWaitingForInput(toolCall);
  const commandText = getCommandText(toolCall.arguments);
  const commandOutput = getToolCallOutputText(toolCall.result).trim();
  const commandDescription = (() => {
    const args = toolCall.arguments as Record<string, unknown> | undefined;
    if (!args) return "执行命令";
    const preferred =
      (typeof args.description === "string" ? args.description : null) ||
      (typeof args.summary === "string" ? args.summary : null) ||
      (typeof args.title === "string" ? args.title : null) ||
      (typeof args.action === "string" ? args.action : null);
    return preferred?.trim() || "执行命令";
  })();

  const handleForceComplete = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation();
      forceComplete(toolCall.id);
    },
    [forceComplete, toolCall.id],
  );

  const formatDuration = (ms: number) => {
    if (ms < 1000) return `${ms}ms`;
    return `${(ms / 1000).toFixed(1)}s`;
  };

  const getDetailType = (
    toolName: string,
  ): "search" | "file" | "terminal" | "mcp" => {
    const name = toolName.toLowerCase();
    if (name.includes("search") || name.includes("web")) return "search";
    if (
      name.includes("file") ||
      name.includes("read") ||
      name.includes("write")
    )
      return "file";
    if (name.includes("bash") || name.includes("shell")) return "terminal";
    return "mcp";
  };

  // Extract a brief summary from arguments
  const getSummary = (): string | null => {
    const args = toolCall.arguments;
    if (!args) return null;

    // Try common argument names
    if (typeof args === "object") {
      const summary =
        (args as Record<string, unknown>).path ||
        (args as Record<string, unknown>).command ||
        (args as Record<string, unknown>).query ||
        (args as Record<string, unknown>).url ||
        (args as Record<string, unknown>).pattern;
      if (typeof summary === "string") {
        return summary.length > 60 ? summary.slice(0, 60) + "..." : summary;
      }
    }
    return null;
  };

  const summary = getSummary();
  const compactToolName = toolCall.name.toLowerCase();
  const isCompactSearchTool =
    compactToolName.includes("grep") ||
    compactToolName === "glob" ||
    compactToolName === "find";
  const isTodo = isTodoTool(toolCall.name);
  const statusGlyphClass =
    toolCall.status === "completed"
      ? "text-green-600 dark:text-green-400"
      : toolCall.status === "failed"
        ? "text-red-600 dark:text-red-400"
        : "text-muted-foreground";
  const statusGlyph = (() => {
    if (toolCall.status === "completed") return "✓";
    if (toolCall.status === "failed") return "✕";
    return "●";
  })();

  const getCompactTitle = () => {
    if (compactToolName.includes("grep")) return "Grep";
    if (compactToolName === "glob") return "Glob";
    if (compactToolName === "find") return "Find";
    if (isTodo) return "Todo";
    return formatToolName(toolCall.name);
  };

  const parseTodoSummary = () => {
    if (!isTodo || typeof toolCall.result !== "string" || !toolCall.result.trim()) {
      return null;
    }

    try {
      const parsed = JSON.parse(toolCall.result) as Array<{ status?: string }>;
      if (!Array.isArray(parsed)) return null;

      const total = parsed.length;
      const inProgress = parsed.filter((item) => item?.status === "in_progress").length;
      const completed = parsed.filter((item) => item?.status === "completed").length;

      return {
        primary: `${total} items updated`,
        meta:
          inProgress > 0
            ? `${inProgress} in progress`
            : completed === total && total > 0
              ? "all done"
              : null,
      };
    } catch {
      return null;
    }
  };

  const todoSummary = parseTodoSummary();
  const commandStatusText = isWaitingForInput
    ? "等待终端输入"
    : isTimedOut
      ? "运行时间过长"
      : toolCall.status === "failed"
        ? "已失败"
        : toolCall.status === "waiting"
          ? "等待中"
          : null;

  const getCompactPrimary = () => {
    if (isCompactSearchTool) {
      return summary || "";
    }

    if (isTodo) {
      if (todoSummary) {
        return todoSummary.primary;
      }
      const text = typeof toolCall.result === "string" ? toolCall.result : summary || "";
      return text.split("·")[0]?.trim() || "items updated";
    }
    return summary || "";
  };

  const getCompactMeta = () => {
    if (isCompactSearchTool) {
      return null;
    }

    if (
      isTodo &&
      todoSummary
    ) {
      return todoSummary.meta;
    }

    if (
      isTodo &&
      typeof toolCall.result === "string" &&
      toolCall.result &&
      toolCall.result.includes("·")
    ) {
      return toolCall.result.split("·").slice(1).join("·").trim();
    }
    return null;
  };

  // If this is a Write tool, render WriteToolCard
  if (isWriteTool(toolCall.name)) {
    return <WriteToolCard toolCall={toolCall} />;
  }

  // If this is an Edit tool, render EditToolCard
  if (isEditTool(toolCall.name)) {
    return <EditToolCard toolCall={toolCall} />;
  }

  // If this is a Read tool, render minimal ReadToolCard
  if (isReadTool(toolCall.name)) {
    return <ReadToolCard toolCall={toolCall} />;
  }

  // If this is a Skill tool, render SkillToolCard
  if (isSkillTool(toolCall.name)) {
    return <SkillToolCard toolCall={toolCall} />;
  }

  if (isRoleSkillTool(toolCall.name)) {
    return <RoleSkillToolCard toolCall={toolCall} />;
  }

  if (isRoleLoadTool(toolCall.name)) {
    return <RoleLoadToolCard toolCall={toolCall} />;
  }

  // If this is a Task tool (subagent), render TaskToolCard
  if (isTaskTool(toolCall.name)) {
    return <TaskToolCard toolCall={toolCall} />;
  }

  // If this is a question tool with questions, render the QuestionCard
  if (isQuestionTool(toolCall.name)) {
    // Extract questions from arguments
    const args = toolCall.arguments as {
      questions?: Array<{
        question: string;
        header?: string;
        options: Array<{ id?: string; label: string; value?: string }>;
      }>;
    };
    const rawQuestions = toolCall.questions ?? args?.questions;
    const questions = Array.isArray(rawQuestions) ? rawQuestions : [];

    if (questions.length > 0) {
      return (
        <QuestionCard
          toolCallId={toolCall.id}
          questions={questions}
          isCompleted={toolCall.status === "completed"}
        />
      );
    }
  }

  if (isCommand) {
    return (
      <div
        data-testid="tool-card-bash"
        className="overflow-hidden rounded-[14px] border border-[#e7edf4] bg-[#fbfcfe] dark:border-border dark:bg-card"
      >
        <button
          type="button"
          onClick={() => setExpanded((value) => !value)}
          className="flex w-full items-center gap-[10px] px-[14px] py-[10px] text-left transition-colors hover:bg-[#f4f7fa] dark:hover:bg-muted/30"
          aria-expanded={expanded}
          aria-label={`${commandDescription} ${summary || commandText}`.trim()}
        >
          <ChevronRight
            size={13}
            className={cn(
              "shrink-0 text-[#64748b] transition-transform duration-200 dark:text-muted-foreground",
              expanded && "rotate-90",
            )}
          />
          <span className="text-[13px] font-semibold text-[#1f2933] shrink-0 dark:text-foreground">{commandDescription}</span>
          {commandStatusText ? (
            <span className="text-[11px] text-[#64748b] dark:text-muted-foreground">
              {commandStatusText}
            </span>
          ) : null}
          <span className="max-w-[20rem] truncate text-[11px] font-mono text-[#64748b] dark:text-muted-foreground">
            {summary || commandText}
          </span>
          <span className="ml-auto" />
          <span className={cn("shrink-0 text-[13px]", statusGlyphClass)}>{statusGlyph}</span>
        </button>
        {(isWaitingForInput || isTimedOut) && (
          <div className="border-t border-[#eef2f5] px-[14px] py-3 dark:border-border/60">
            <div className="rounded-[10px] border border-amber-200/80 bg-amber-50/60 px-3 py-2.5 text-[12px] text-amber-950 dark:border-amber-900/60 dark:bg-amber-950/20 dark:text-amber-200">
              <div className="flex items-start gap-2">
                <AlertTriangle size={14} className="mt-0.5 shrink-0" />
                <div className="min-w-0 flex-1">
                  <div className="font-medium">
                    {isWaitingForInput ? "命令正在等待确认或标准输入。" : "命令运行时间过长。"}
                  </div>
                  <div className="mt-1 text-[11px] text-amber-900/80 dark:text-amber-200/80">
                    {isWaitingForInput
                      ? "优先使用非交互参数，或者先向用户提问再继续执行。"
                      : "如果确认当前不会再有输出，可以直接标记为完成。"}
                  </div>
                </div>
                {isTimedOut ? (
                  <button
                    type="button"
                    onClick={handleForceComplete}
                    className="shrink-0 rounded-[8px] border border-amber-300 bg-white px-2.5 py-1 text-[11px] font-medium text-amber-900 transition-colors hover:bg-amber-100 dark:border-amber-800 dark:bg-amber-950/30 dark:text-amber-100 dark:hover:bg-amber-900/40"
                  >
                    标记为完成
                  </button>
                ) : null}
              </div>
            </div>
          </div>
        )}
        {expanded ? (
          <div
            data-testid="tool-card-bash-output"
            className="max-h-[220px] overflow-auto border-t border-[#eef2f5] bg-white/80 px-[14px] py-3 dark:border-border/60 dark:bg-background/40"
          >
            <pre className="whitespace-pre-wrap break-words font-mono text-[11px] leading-5 text-foreground/85">
              {commandOutput || "无输出"}
            </pre>
          </div>
        ) : null}
      </div>
    )
  }

  if (isCompactSearchTool || isTodo) {
    const rowTestId = `tool-row-${compactToolName.includes("grep") ? "grep" : compactToolName === "glob" ? "glob" : compactToolName.includes("bash") ? "bash" : compactToolName === "role_skill" ? "role-skill" : compactToolName}`
    const primaryText = getCompactPrimary()
    const metaText = getCompactMeta()

    return (
      <div
        data-testid={rowTestId}
        className="grid grid-cols-[minmax(0,1fr)] items-center px-[10px] py-[4px]"
      >
        <span className="min-w-0 text-[12px] text-[#475569] dark:text-slate-400">
          <strong className="font-medium text-foreground/80">{getCompactTitle()}</strong>
          {primaryText ? <span className="ml-1 font-mono text-foreground/70">{primaryText}</span> : null}
          {metaText ? <span className="ml-1 text-[#94a3b8] dark:text-muted-foreground">· {metaText}</span> : null}
        </span>
      </div>
    )
  }

  return (
    <div className="space-y-2">
      <Collapsible open={expanded} onOpenChange={setExpanded}>
        <div className="rounded-lg border border-border bg-muted/30 overflow-hidden transition-all duration-200">
          <CollapsibleTrigger asChild>
            <button className="w-full flex items-center gap-2 px-3 py-2 text-left bg-muted/50 hover:bg-muted/70 transition-colors">
              <ChevronRight
                size={14}
                className={cn(
                  "text-muted-foreground transition-transform duration-200 shrink-0",
                  expanded && "rotate-90",
                )}
              />
              <ToolIcon size={14} className="text-muted-foreground shrink-0" />
              <span className="text-xs font-medium text-foreground">
                {formatToolName(toolCall.name)}
              </span>
              {summary && !expanded && (
                <span className="text-xs text-muted-foreground truncate flex-1 max-w-[200px] font-mono">
                  {summary}
                </span>
              )}
              <div className="ml-auto flex items-center gap-2">
                {toolCall.duration && (
                  <span className="text-[10px] text-muted-foreground/70">
                    {formatDuration(toolCall.duration)}
                  </span>
                )}
                {isTimedOut ? (
                  <button
                    onClick={handleForceComplete}
                    className="flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] bg-muted hover:bg-muted/80 text-foreground border border-border transition-colors"
                    title={
                      isCommand
                        ? "Command may be blocked waiting for terminal input - click to mark as done"
                        : "Tool call timed out - click to mark as done"
                    }
                  >
                    <AlertTriangle size={10} />
                    <span>{isCommand ? "Waiting input" : "Timed out"}</span>
                    <CheckCircle2 size={10} />
                  </button>
                ) : isWaitingForInput ? (
                  <div
                    className="flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] bg-amber-100 text-amber-800 border border-amber-200"
                    title="Command output looks like it is waiting for confirmation or stdin input"
                  >
                    <AlertTriangle size={10} />
                    <span>Input needed</span>
                  </div>
                ) : (
                  <StatusIcon
                    size={14}
                    className={cn(
                      config.textColor,
                      config.animate && "animate-spin",
                    )}
                  />
                )}
              </div>
            </button>
          </CollapsibleTrigger>

          <CollapsibleContent>
            <div className="px-3 pb-3 pt-1 text-xs space-y-2 border-t border-border/50">
              {isCommand && (isWaitingForInput || isTimedOut) && (
                <div className="flex items-start gap-2 rounded-md border border-amber-200 bg-amber-50 px-2 py-2 text-[11px] text-amber-900">
                  <AlertTriangle size={12} className="mt-0.5 shrink-0" />
                  <div className="space-y-1">
                    <p className="font-medium">
                      {isWaitingForInput
                        ? "This command looks like it is waiting for terminal input."
                        : "This command has been running for a while."}
                    </p>
                    <p className="text-amber-800/90">
                      Prefer non-interactive flags like `--yes` or `-y`. If input is required, ask a question before running the command.
                    </p>
                    {commandText && (
                      <p className="font-mono text-[10px] break-all text-amber-800/80">
                        {commandText}
                      </p>
                    )}
                  </div>
                </div>
              )}

              {toolCall.arguments &&
                Object.keys(toolCall.arguments).length > 0 && (
                  <div>
                    <span className="text-muted-foreground font-medium">
                      Arguments
                    </span>
                    <pre className="mt-1 p-2 bg-background/60 rounded text-[10px] overflow-x-auto font-mono max-h-24">
                      {JSON.stringify(toolCall.arguments, null, 2)}
                    </pre>
                  </div>
                )}

              {(() => {
                let resultContent = toolCall.result;

                if (resultContent && typeof resultContent === "object") {
                  const resultObj = resultContent as Record<string, unknown>;
                  if (Array.isArray(resultObj.content)) {
                    const textParts = resultObj.content
                      .filter(
                        (c: unknown) =>
                          c &&
                          typeof c === "object" &&
                          (c as Record<string, unknown>).type === "text",
                      )
                      .map((c: unknown) => (c as Record<string, unknown>).text)
                      .join("\n");
                    if (textParts) resultContent = textParts;
                  } else if (resultObj.text) {
                    resultContent = resultObj.text;
                  } else if (resultObj.output) {
                    resultContent = resultObj.output;
                  }
                }

                if (resultContent !== undefined && resultContent !== null) {
                  const displayText =
                    typeof resultContent === "string"
                      ? resultContent.slice(0, 500) +
                        (resultContent.length > 500 ? "..." : "")
                      : JSON.stringify(resultContent, null, 2);

                  return (
                    <div>
                      <span className="text-muted-foreground font-medium">
                        Result
                      </span>
                      <pre className="mt-1 p-2 bg-background/60 rounded text-[10px] overflow-x-auto max-h-48 font-mono whitespace-pre-wrap">
                        {displayText}
                      </pre>
                    </div>
                  );
                }
                return null;
              })()}

              {(!toolCall.arguments ||
                Object.keys(toolCall.arguments).length === 0) &&
                (toolCall.result === undefined || toolCall.result === null) && (
                  <div className="text-muted-foreground/60 italic py-2">
                    No details available
                  </div>
                )}

              {onOpenDetail && (
                <button
                  onClick={() =>
                    onOpenDetail(getDetailType(toolCall.name), toolCall)
                  }
                  className="text-[10px] text-muted-foreground hover:text-foreground hover:underline"
                >
                  View full details →
                </button>
              )}
            </div>
          </CollapsibleContent>
        </div>
      </Collapsible>

      {!!toolCall.questions?.length && (
        <QuestionCard
          toolCallId={toolCall.id}
          questions={toolCall.questions}
          isCompleted={toolCall.status === "completed"}
        />
      )}
    </div>
  );
});

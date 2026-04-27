import React, { useState } from "react";
import { useTranslation } from "react-i18next";
import {
  ChevronRight,
  HelpCircle,
  Loader2,
  Terminal,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { ToolCall } from "@/stores/session";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { getCommandText, getToolCallOutputText } from "@/lib/terminal-interaction";

// Import sub-cards and utilities from tool-calls/
import { ToolCallStatusGlyph } from "./tool-calls/ToolCallStatusGlyph";
import { WriteToolCard } from "./tool-calls/WriteToolCard";
import { EditToolCard } from "./tool-calls/EditToolCard";
import { ReadToolCard } from "./tool-calls/ReadToolCard";
import { RoleLoadToolCard } from "./tool-calls/RoleLoadToolCard";
import { RoleSkillToolCard, SkillToolCard, TaskToolCard } from "./tool-calls/TaskToolCard";
import {
  getStatusConfig,
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
  formatToolName,
} from "./tool-calls/tool-call-utils";

interface ToolCallCardProps {
  toolCall: ToolCall;
  onOpenDetail?: (
    type: "search" | "file" | "terminal" | "mcp",
    data: unknown,
  ) => void;
}

export const ToolCallCard = React.memo(function ToolCallCard({ toolCall, onOpenDetail }: ToolCallCardProps) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(false);
  const config = getStatusConfig((key, fallback, options) =>
    t(key, { defaultValue: fallback, ...options }),
  )[toolCall.status];
  const StatusIcon = config.icon;
  const isCommand = isCommandTool(toolCall.name);
  const commandText = getCommandText(toolCall.arguments);
  const commandOutput = getToolCallOutputText(toolCall.result).trim();
  const commandDescription = (() => {
    const args = toolCall.arguments as Record<string, unknown> | undefined;
    if (!args) return t("chat.toolCall.command.defaultDescription", "Execute command");
    const preferred =
      (typeof args.description === "string" ? args.description : null) ||
      (typeof args.summary === "string" ? args.summary : null) ||
      (typeof args.title === "string" ? args.title : null) ||
      (typeof args.action === "string" ? args.action : null);
    return preferred?.trim() || t("chat.toolCall.command.defaultDescription", "Execute command");
  })();

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

  const renderExpandableHeaderSlot = (icon: React.ReactNode, testId?: string) => (
    <span className="relative h-[22px] w-[22px] shrink-0" aria-hidden="true">
      <span
        data-testid={testId}
        className="absolute inset-0 flex items-center justify-center group-hover:opacity-0"
      >
        {icon}
      </span>
      <span className="absolute inset-0 flex items-center justify-center opacity-0 group-hover:opacity-100">
        <ChevronRight
          size={13}
          className={cn(
            "text-[#64748b] transition-transform duration-200 dark:text-muted-foreground",
            expanded && "rotate-90",
          )}
        />
      </span>
    </span>
  );

  const getCompactTitle = () => {
    if (compactToolName.includes("grep")) return t("chat.toolCall.search.grep", "Grep");
    if (compactToolName === "glob") return t("chat.toolCall.search.glob", "Glob");
    if (compactToolName === "find") return t("chat.toolCall.search.find", "Find");
    if (isTodo) return t("chat.toolCall.todo.title", "Todo");
    return formatToolName((key, fallback, options) => t(key, { defaultValue: fallback, ...options }), toolCall.name);
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
        primary: t("chat.toolCall.todo.itemsUpdated", "{{count}} items updated", { count: total }),
        meta:
          inProgress > 0
            ? t("chat.toolCall.todo.inProgressCount", "{{count}} in progress", { count: inProgress })
            : completed === total && total > 0
              ? t("chat.toolCall.todo.allDone", "all done")
              : null,
      };
    } catch {
      return null;
    }
  };

  const todoSummary = parseTodoSummary();
  const commandStatusText =
    toolCall.status === "failed"
      ? t("chat.toolCall.status.failed", "Failed")
      : toolCall.status === "waiting"
        ? t("chat.toolCall.status.waiting", "Waiting")
        : null;

  const getQuestionCount = () => {
    if (Array.isArray(toolCall.questions)) return toolCall.questions.length;
    const args = toolCall.arguments as { questions?: unknown } | undefined;
    return Array.isArray(args?.questions) ? args.questions.length : 0;
  };

  const getCompactPrimary = () => {
    if (isCompactSearchTool) {
      return summary || "";
    }

    if (isTodo) {
      if (todoSummary) {
        return todoSummary.primary;
      }
      const text = typeof toolCall.result === "string" ? toolCall.result : summary || "";
      return text.split("·")[0]?.trim() || t("chat.toolCall.todo.itemsUpdatedFallback", "items updated");
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

  if (isQuestionTool(toolCall.name)) {
    const questionCount = getQuestionCount();
    const isQuestionLoading = questionCount === 0 && (toolCall.status === "calling" || toolCall.status === "waiting");
    const questionCountText = t(
      questionCount === 1 ? "chat.toolCall.question.countOne" : "chat.toolCall.question.count",
      questionCount === 1 ? "{{count}} question" : "{{count}} questions",
      { count: questionCount },
    );

    return (
      <div
        data-testid="tool-row-question"
        className="flex items-center gap-1.5 px-[10px] py-[4px] text-[12px] text-muted-foreground"
      >
        <HelpCircle className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
        <span className="font-medium text-foreground/80">
          {t("chat.toolCall.question.title", "Question")}
        </span>
        {questionCount > 0 ? (
          <>
            <span className="text-muted-foreground">·</span>
            <span>{questionCountText}</span>
          </>
        ) : null}
        {isQuestionLoading ? (
          <Loader2
            data-testid="question-tool-loading"
            className="h-3 w-3 animate-spin text-muted-foreground"
            aria-hidden="true"
          />
        ) : null}
      </div>
    );
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
          className="group flex w-full items-center gap-[10px] px-[14px] py-[10px] text-left transition-colors hover:bg-[#f4f7fa] dark:hover:bg-muted/30"
          aria-expanded={expanded}
          aria-label={`${commandDescription} ${summary || commandText}`.trim()}
        >
          {renderExpandableHeaderSlot(
            <Terminal size={13} className="text-[#64748b] dark:text-muted-foreground" />,
          )}
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
          <ToolCallStatusGlyph status={toolCall.status} className="shrink-0" />
        </button>
        {expanded ? (
          <div
            data-testid="tool-card-bash-output"
            className="max-h-[280px] overflow-auto border-t border-[#eef2f5] bg-white px-[16px] py-[14px] dark:border-border/60 dark:bg-[#101318]"
          >
            <div className="space-y-4 font-mono">
              <div>
                <div className="flex items-start gap-2 text-[12px] leading-6 text-[#1f2937] dark:text-[#f3f4f6]">
                  <span className="shrink-0 text-[#64748b] dark:text-[#94a3b8]">$</span>
                  <pre className="min-w-0 whitespace-pre-wrap break-words">{commandText}</pre>
                </div>
              </div>
              <div>
                <pre className="whitespace-pre-wrap break-words text-[12px] leading-6 text-[#475569] dark:text-[#cbd5e1]">
                  {commandOutput || t("chat.toolCall.command.noOutput", "No output")}
                </pre>
              </div>
            </div>
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

  const fallbackArgCount = toolCall.arguments ? Object.keys(toolCall.arguments).length : 0;
  const fallbackSummary =
    summary ||
    (typeof toolCall.arguments === "object" && toolCall.arguments
      ? (["description", "title", "action", "query", "url"] as const)
          .map((key) => toolCall.arguments?.[key])
          .find((value): value is string => typeof value === "string" && value.trim().length > 0)
      : null) ||
    null;

  return (
    <div className="space-y-2">
      <Collapsible open={expanded} onOpenChange={setExpanded}>
        <div className="overflow-hidden rounded-[16px] border border-[#e7edf4] bg-[#fbfcfe] transition-all duration-200 dark:border-border dark:bg-card">
          <CollapsibleTrigger asChild>
            <button className="group w-full flex items-center gap-[10px] px-[12px] py-[10px] text-left transition-colors hover:bg-[#f4f7fa] dark:hover:bg-muted/30">
              {renderExpandableHeaderSlot(
                <span
                  className="relative h-[22px] w-[22px] shrink-0 rounded-[8px] border border-[#e2e8f0] bg-[#f8fafc] dark:border-border dark:bg-muted/20"
                  aria-hidden="true"
                >
                  <span className="absolute left-[4px] top-[5px] h-[5px] w-[5px] rounded-full bg-[#475569] dark:bg-slate-300" />
                  <span className="absolute left-[12px] top-[5px] h-[4px] w-[4px] rounded-full bg-[#94a3b8] dark:bg-slate-500" />
                  <span className="absolute left-[8px] top-[12px] h-[6px] w-[6px] rounded-full bg-[#cbd5e1] dark:bg-slate-600" />
                </span>,
                "tool-fallback-icon",
              )}
              <span className="min-w-0 flex-1 text-[13px] font-medium text-[#1f2933] dark:text-foreground">
                {formatToolName((key, fallback, options) => t(key, { defaultValue: fallback, ...options }), toolCall.name)}
              </span>
              {!expanded && fallbackSummary && (
                <span className="max-w-[18rem] truncate text-[11px] text-[#64748b] dark:text-muted-foreground">
                  {fallbackSummary}
                </span>
              )}
              <div className="ml-auto flex items-center gap-2">
                {fallbackArgCount > 0 && (
                  <span className="rounded-full border border-[#e2e8f0] bg-[#f8fafc] px-[6px] py-[1px] text-[10px] text-[#64748b] dark:border-border dark:bg-muted/20 dark:text-muted-foreground">
                    {t("chat.toolCall.argCount", "{{count}} args", { count: fallbackArgCount })}
                  </span>
                )}
                {toolCall.duration && (
                  <span className="text-[10px] text-[#94a3b8] dark:text-muted-foreground/70">
                    {formatDuration(toolCall.duration)}
                  </span>
                )}
                <StatusIcon
                  size={13}
                  className={cn(
                    config.textColor,
                    config.animate && "animate-spin",
                  )}
                />
              </div>
            </button>
          </CollapsibleTrigger>

          <CollapsibleContent>
            <div className="space-y-2 border-t border-[#eef2f5] bg-white/80 px-[12px] pb-3 pt-2 text-xs dark:border-border/60 dark:bg-background/40">
              {toolCall.arguments &&
                Object.keys(toolCall.arguments).length > 0 && (
                  <div>
                    <span className="text-muted-foreground font-medium">
                      {t("chat.toolCall.arguments", "Arguments")}
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
                        {t("chat.toolCall.result", "Result")}
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
                    {t("chat.toolCall.noDetails", "No details available")}
                  </div>
                )}

              {onOpenDetail && (
                <button
                  onClick={() =>
                    onOpenDetail(getDetailType(toolCall.name), toolCall)
                  }
                  className="text-[10px] text-muted-foreground hover:text-foreground hover:underline"
                >
                  {t("chat.toolCall.viewFullDetails", "View full details")} →
                </button>
              )}
            </div>
          </CollapsibleContent>
        </div>
      </Collapsible>

    </div>
  );
});

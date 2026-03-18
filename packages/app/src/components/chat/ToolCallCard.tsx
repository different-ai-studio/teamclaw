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

// Import sub-cards and utilities from tool-calls/
import { WriteToolCard } from "./tool-calls/WriteToolCard";
import { EditToolCard } from "./tool-calls/EditToolCard";
import { ReadToolCard } from "./tool-calls/ReadToolCard";
import { SkillToolCard, TaskToolCard } from "./tool-calls/TaskToolCard";
import { PermissionApprovalBar } from "./tool-calls/PermissionApprovalBar";
import {
  statusConfig,
  getToolIcon,
  isQuestionTool,
  isWriteTool,
  isEditTool,
  isReadTool,
  isTaskTool,
  isSkillTool,
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
    const questions = toolCall.questions || args?.questions;

    if (questions && questions.length > 0) {
      return (
        <QuestionCard
          toolCallId={toolCall.id}
          questions={questions}
          isCompleted={toolCall.status === "completed"}
        />
      );
    }
  }

  return (
    <Collapsible open={expanded} onOpenChange={setExpanded}>
      <div className="rounded-lg border border-border bg-muted/30 overflow-hidden transition-all duration-200">
        <CollapsibleTrigger asChild>
          <button className="w-full flex items-center gap-2 px-3 py-2 text-left bg-muted/50 hover:bg-muted/70 transition-colors">
            {/* Expand icon */}
            <ChevronRight
              size={14}
              className={cn(
                "text-muted-foreground transition-transform duration-200 shrink-0",
                expanded && "rotate-90",
              )}
            />

            {/* Tool icon */}
            <ToolIcon size={14} className="text-muted-foreground shrink-0" />

            {/* Tool name */}
            <span className="text-xs font-medium text-foreground">
              {formatToolName(toolCall.name)}
            </span>

            {/* Summary (if available and not expanded) */}
            {summary && !expanded && (
              <span className="text-xs text-muted-foreground truncate flex-1 max-w-[200px] font-mono">
                {summary}
              </span>
            )}

            {/* Status indicator */}
            <div className="ml-auto flex items-center gap-2">
              {/* Duration */}
              {toolCall.duration && (
                <span className="text-[10px] text-muted-foreground/70">
                  {formatDuration(toolCall.duration)}
                </span>
              )}

              {/* Status icon or timeout button */}
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
            {/* Arguments */}
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

            {/* Result - handle various result formats */}
            {(() => {
              // Extract result content - handle different formats
              let resultContent = toolCall.result;

              // If result is an object with content array (common MCP format)
              if (resultContent && typeof resultContent === "object") {
                const resultObj = resultContent as Record<string, unknown>;
                // Check for common MCP result structures
                if (Array.isArray(resultObj.content)) {
                  // Extract text from content array
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

            {/* Show placeholder if no content */}
            {(!toolCall.arguments ||
              Object.keys(toolCall.arguments).length === 0) &&
              (toolCall.result === undefined || toolCall.result === null) && (
                <div className="text-muted-foreground/60 italic py-2">
                  No details available
                </div>
              )}

            {/* View details link */}
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

        <PermissionApprovalBar toolCall={toolCall} />
      </div>
    </Collapsible>
  );
});

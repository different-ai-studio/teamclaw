import React, { useState, useCallback } from "react";
import {
  ChevronRight,
  Zap,
  Bot,
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
import {
  statusConfig,
  useToolCallTimeout,
} from "./tool-call-utils";
import { PermissionApprovalBar } from "./PermissionApprovalBar";

// Skill Tool Card - Shows skill execution inline
export function SkillToolCard({ toolCall }: { toolCall: ToolCall }) {
  const [expanded, setExpanded] = useState(false);
  const isTimedOut = useToolCallTimeout(toolCall);
  const forceComplete = useSessionStore((s) => s.forceCompleteToolCall);

  const args = toolCall.arguments as {
    name?: string;
    [key: string]: unknown;
  };

  const skillName = args?.name || "Unknown Skill";
  const config = statusConfig[toolCall.status];
  const StatusIcon = config.icon;

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
            <Zap size={14} className="text-muted-foreground shrink-0" />

            {/* Tool name - show "Skill" + skill name */}
            <span className="text-xs font-medium text-foreground">
              Skill {skillName}
            </span>

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
            {/* Result */}
            {toolCall.result !== undefined && toolCall.result !== null && (
              <div>
                <span className="text-muted-foreground font-medium">Result</span>
                <div className="mt-1 p-2 rounded-md bg-muted/30 border border-border/30 max-h-[400px] overflow-y-auto">
                  <pre className="whitespace-pre-wrap text-xs text-foreground/90 m-0 p-0 font-mono">
                    {String(typeof toolCall.result === 'string' ? toolCall.result : JSON.stringify(toolCall.result, null, 2))}
                  </pre>
                </div>
              </div>
            )}
          </div>
        </CollapsibleContent>
        <PermissionApprovalBar toolCall={toolCall} />
      </div>
    </Collapsible>
  );
}

export function RoleSkillToolCard({ toolCall }: { toolCall: ToolCall }) {
  const [expanded, setExpanded] = useState(false);
  const isTimedOut = useToolCallTimeout(toolCall);
  const forceComplete = useSessionStore((s) => s.forceCompleteToolCall);

  const args = toolCall.arguments as {
    name?: string;
    [key: string]: unknown;
  };

  const skillName = args?.name || "Unknown Skill";
  const config = statusConfig[toolCall.status];
  const StatusIcon = config.icon;

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

  return (
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
            <Zap size={14} className="text-muted-foreground shrink-0" />
            <span className="text-xs font-medium text-foreground">
              Role skill
            </span>
            <span className="rounded-full border border-border bg-background/80 px-2 py-0.5 text-[11px] font-mono text-foreground/90">
              {skillName}
            </span>

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
            {toolCall.result !== undefined && toolCall.result !== null && (
              <div>
                <span className="text-muted-foreground font-medium">Result</span>
                <div className="mt-1 p-2 rounded-md bg-muted/30 border border-border/30 max-h-[400px] overflow-y-auto">
                  <pre className="whitespace-pre-wrap break-words text-xs text-foreground/90 m-0 p-0 font-mono">
                    {String(typeof toolCall.result === "string" ? toolCall.result : JSON.stringify(toolCall.result, null, 2))}
                  </pre>
                </div>
              </div>
            )}
          </div>
        </CollapsibleContent>
        <PermissionApprovalBar toolCall={toolCall} />
      </div>
    </Collapsible>
  );
}

// Task Tool Card - Shows subagent execution inline with visual distinction
export function TaskToolCard({ toolCall }: { toolCall: ToolCall }) {
  const args = toolCall.arguments as {
    description?: string;
    subagent_type?: string;
  };

  const result = toolCall.result as string | undefined;
  let sessionId = toolCall.metadata?.sessionId || "";

  if (typeof result === "string") {
    const sessionMatch = result.match(/session_id:\s*([^\n<\s]+)/);
    if (sessionMatch && !sessionId) {
      sessionId = sessionMatch[1].trim();
    }
  }

  const config = statusConfig[toolCall.status];
  const StatusIcon = config.icon;

  const description = args?.description || "Subagent Task";
  const subagentType = args?.subagent_type || "explore";

  const openChildSession = useCallback(() => {
    if (sessionId) {
      useSessionStore.getState().setViewingChildSession(sessionId);
    }
  }, [sessionId]);

  return (
    <div className="border-l-2 border-border pl-3 py-1">
      <div className="flex items-center gap-2 text-[11px]">
        <Bot size={12} className="text-muted-foreground" />
        <span className="text-foreground font-medium">@{subagentType}</span>
        <span className="text-muted-foreground truncate">{description}</span>
        {toolCall.duration && (
          <span className="text-[10px] text-muted-foreground/70">
            {toolCall.duration < 1000
              ? `${toolCall.duration}ms`
              : `${(toolCall.duration / 1000).toFixed(1)}s`}
          </span>
        )}
        {sessionId && (
          <button
            type="button"
            onClick={openChildSession}
            className="rounded border border-border bg-background/70 px-2 py-0.5 text-[10px] text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
            title="打开子会话"
          >
            查看会话
          </button>
        )}
        <StatusIcon
          size={12}
          className={cn(config.textColor, config.animate && "animate-spin")}
        />
      </div>
    </div>
  );
}

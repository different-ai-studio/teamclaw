import React, { useState, useEffect, useCallback } from "react";
import {
  ChevronRight,
  Loader2,
  Eye,
  Zap,
  Bot,
  AlertTriangle,
  CheckCircle2,
  Terminal,
} from "lucide-react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { cn, openExternalUrl } from "@/lib/utils";
import { getOpenCodeClient } from "@/lib/opencode/sdk-client";
import { ToolCall, useSessionStore, convertMessage } from "@/stores/session";
import { useStreamingStore } from "@/stores/streaming";
import { useWorkspaceStore } from "@/stores/workspace";
import {
  getCommandText,
  getToolCallOutputText,
} from "@/lib/terminal-interaction";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import {
  statusConfig,
  formatToolName,
  useToolCallTimeout,
  isCommandTool,
  isCommandToolLikelyWaitingForInput,
} from "./tool-call-utils";

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
      </div>
    </Collapsible>
  );
}

// Task Tool Card - Shows subagent execution inline with visual distinction
export function TaskToolCard({ toolCall }: { toolCall: ToolCall }) {
  const args = toolCall.arguments as {
    description?: string;
    prompt?: string;
    subagent_type?: string;
  };

  // Parse result to get output and session ID
  const result = toolCall.result as string | undefined;
  let output = "";
  let sessionId = toolCall.metadata?.sessionId || "";

  // Result format includes various metadata tags:
  // - <task_id>xxx</task_id>
  // - <task_result>output</task_result>
  // - <session>session_id: xxx</session>
  // - session_id: xxx
  if (typeof result === "string") {
    let cleanedResult = result;

    // Extract session ID from various formats
    const sessionMatch = result.match(/session_id:\s*([^\n<\s]+)/);
    if (sessionMatch && !sessionId) {
      sessionId = sessionMatch[1].trim();
    }

    // Clean up all backend metadata tags
    cleanedResult = cleanedResult
      // Remove <task_id>...</task_id>
      .replace(/<task_id>[\s\S]*?<\/task_id>/g, "")
      // Remove <task_result>...</task_result> but keep the content inside
      .replace(/<task_result>([\s\S]*?)<\/task_result>/g, "$1")
      // Remove <session>...</session>
      .replace(/<session>[\s\S]*?<\/session>/g, "")
      // Remove task_id: xxx (with or without underscore, keep content after space)
      .replace(/\b_?task_id:\s*\S+\s*/g, "")
      // Remove session_id: xxx
      .replace(/\bsession_id:\s*\S+\s*/g, "")
      // Remove "for resuming to continue this task if needed" text
      .replace(/\(for resuming to continue this task if needed\)/g, "")
      // Clean up extra whitespace and empty lines
      .replace(/^\s*[\r\n]/gm, "")
      .replace(/\n{3,}/g, "\n\n")
      .trim();

    output = cleanedResult;
  }

  // Read streaming content from child session
  const childStreaming = useStreamingStore(
    (s) => sessionId ? s.childSessionStreaming[sessionId] : undefined,
  );
  const streamingText = childStreaming?.text || "";
  const isChildStreaming = childStreaming?.isStreaming ?? false;

  // Auto-scroll streaming content
  const streamingRef = React.useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (streamingRef.current && isChildStreaming) {
      streamingRef.current.scrollTop = streamingRef.current.scrollHeight;
    }
  }, [streamingText, isChildStreaming]);

  const config = statusConfig[toolCall.status];
  const StatusIcon = config.icon;

  const description = args?.description || "Subagent Task";
  const subagentType = args?.subagent_type || "explore";

  const markdownClasses =
    "prose prose-sm max-w-none text-xs text-foreground/90 prose-headings:text-foreground prose-headings:text-sm prose-headings:font-semibold prose-headings:my-1 prose-p:text-foreground/80 prose-p:my-1 prose-strong:text-foreground prose-code:text-foreground prose-code:text-[11px] prose-code:bg-muted prose-code:px-1 prose-code:py-0.5 prose-code:rounded prose-pre:bg-muted prose-pre:text-foreground prose-pre:text-[11px] prose-ul:text-foreground/80 prose-ul:my-1 prose-ol:text-foreground/80 prose-ol:my-1 prose-li:text-foreground/80 prose-li:my-0";

  const markdownComponents = {
    a: ({ children, href }: { children?: React.ReactNode; href?: string }) => (
      <a
        href={href}
        target="_blank"
        rel="noopener noreferrer"
        className="text-foreground/80 hover:text-foreground hover:underline"
        onClick={(e) => {
          if (href && /^https?:\/\//.test(href)) {
            e.preventDefault();
            openExternalUrl(href);
          }
        }}
      >
        {children}
      </a>
    ),
    table: ({ children }: { children?: React.ReactNode }) => (
      <div className="overflow-x-auto my-2 rounded border border-border">
        <table className="min-w-full border-collapse text-[11px]">{children}</table>
      </div>
    ),
    thead: ({ children }: { children?: React.ReactNode }) => (
      <thead className="bg-muted/50">{children}</thead>
    ),
    th: ({ children }: { children?: React.ReactNode }) => (
      <th className="border-b border-border px-2 py-1.5 text-left font-semibold text-foreground text-[11px]">{children}</th>
    ),
    tr: ({ children }: { children?: React.ReactNode }) => (
      <tr className="border-b border-border last:border-b-0">{children}</tr>
    ),
    td: ({ children }: { children?: React.ReactNode }) => (
      <td className="px-2 py-1.5 text-foreground/80 text-[11px]">{children}</td>
    ),
  };

  return (
    <div className="border-l-2 border-border pl-3 py-1 space-y-2">
      {/* Subagent header */}
      <div className="flex items-center gap-2 text-[11px]">
        <Bot size={12} className="text-muted-foreground" />
        <span className="text-foreground font-medium">@{subagentType}</span>
        <span className="text-muted-foreground">{description}</span>
        {toolCall.duration && (
          <span className="text-[10px] text-muted-foreground/70">
            {toolCall.duration < 1000
              ? `${toolCall.duration}ms`
              : `${(toolCall.duration / 1000).toFixed(1)}s`}
          </span>
        )}
        <StatusIcon
          size={12}
          className={cn(config.textColor, config.animate && "animate-spin")}
        />
      </div>

      {/* Running state - tool activity + streaming content */}
      {toolCall.status === "calling" && (
        <div className="space-y-1">
          {toolCall.metadata?.summary &&
          toolCall.metadata.summary.length > 0 ? (
            <>
              {toolCall.metadata.summary.map((item, index) => {
                const itemStatus = item.state?.status || "running";
                const statusCfg =
                  itemStatus === "completed"
                    ? statusConfig.completed
                    : itemStatus === "error"
                      ? statusConfig.failed
                      : itemStatus === "running"
                        ? statusConfig.calling
                        : statusConfig.waiting;
                const ToolStatusIcon = statusCfg.icon;
                const toolName = item.tool || "unknown";
                const title = item.state?.title;

                if (toolName.toLowerCase() === "read") {
                  const fileName = title?.split("/").pop() || title || "";
                  const handleSubagentFileClick = () => {
                    if (!title) return;
                    const ws = useWorkspaceStore.getState().workspacePath;
                    const full = title.startsWith("/") ? title : `${ws}/${title}`;
                    useWorkspaceStore.getState().selectFile(full);
                  };
                  return (
                    <div
                      key={item.id || index}
                      className="flex items-center gap-2 text-[11px] text-muted-foreground cursor-pointer hover:text-foreground/80 transition-colors"
                      onClick={handleSubagentFileClick}
                      title={title || "Open file"}
                    >
                      <Eye size={10} className="shrink-0" />
                      <span className="font-mono truncate">{fileName}</span>
                      <ToolStatusIcon
                        size={10}
                        className={cn(
                          "shrink-0",
                          statusCfg.textColor,
                          statusCfg.animate && "animate-spin",
                        )}
                      />
                    </div>
                  );
                }

                return (
                  <div
                    key={item.id || index}
                    className="flex items-center gap-2 px-2 py-1 bg-muted/30 rounded text-[11px]"
                  >
                    <span className="font-medium text-foreground/80">
                      {formatToolName(toolName)}
                    </span>
                    {title && (
                      <span className="text-muted-foreground truncate flex-1">
                        {title}
                      </span>
                    )}
                    <ToolStatusIcon
                      size={10}
                      className={cn(
                        "shrink-0",
                        statusCfg.textColor,
                        statusCfg.animate && "animate-spin",
                      )}
                    />
                  </div>
                );
              })}
            </>
          ) : null}

          {/* Streaming content from child session */}
          {streamingText ? (
            <div
              ref={streamingRef}
              className="max-h-64 overflow-y-auto border-t border-border/30 pt-1 mt-1"
            >
              <div className={markdownClasses}>
                <ReactMarkdown remarkPlugins={[remarkGfm]} components={markdownComponents}>{streamingText}</ReactMarkdown>
                {isChildStreaming && (
                  <span className="inline-block w-1.5 h-3 bg-foreground/60 animate-pulse ml-0.5 align-text-bottom" />
                )}
              </div>
            </div>
          ) : (
            <div className="flex items-center gap-2 py-0.5 text-muted-foreground">
              <Loader2 size={10} className="animate-spin text-muted-foreground" />
              <span className="text-[10px]">Working...</span>
            </div>
          )}
        </div>
      )}

      {/* Final output */}
      {output && (
        <div className="max-h-64 overflow-y-auto border-t border-border/30 pt-1 mt-1">
          <div className={markdownClasses}>
            <ReactMarkdown remarkPlugins={[remarkGfm]} components={markdownComponents}>{output}</ReactMarkdown>
          </div>
        </div>
      )}

      {/* Subagent Tool Details - expandable, only when sessionId exists */}
      {sessionId && (
        <SubagentToolDetails sessionId={sessionId} />
      )}
    </div>
  );
}

// Cache for child session tool calls to avoid repeated fetches
const childSessionToolCache = new Map<
  string,
  { toolCalls: ToolCall[]; fetchedAt: number }
>();

function SubagentToolDetails({ sessionId }: { sessionId: string }) {
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [toolCalls, setToolCalls] = useState<ToolCall[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetchChildMessages = useCallback(async () => {
    const cached = childSessionToolCache.get(sessionId);
    if (cached) {
      setToolCalls(cached.toolCalls);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const client = getOpenCodeClient();
      const messages = await client.getMessages(sessionId);
      const allToolCalls: ToolCall[] = [];
      for (const msg of messages) {
        const converted = convertMessage(msg);
        if (converted.toolCalls) {
          allToolCalls.push(...converted.toolCalls);
        }
      }
      childSessionToolCache.set(sessionId, {
        toolCalls: allToolCalls,
        fetchedAt: Date.now(),
      });
      setToolCalls(allToolCalls);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setError(msg);
      setToolCalls([]);
    } finally {
      setLoading(false);
    }
  }, [sessionId]);

  useEffect(() => {
    if (detailsOpen && !toolCalls && !loading && !error) {
      fetchChildMessages();
    }
  }, [detailsOpen, toolCalls, loading, error, fetchChildMessages]);

  return (
    <Collapsible open={detailsOpen} onOpenChange={setDetailsOpen}>
      <CollapsibleTrigger asChild>
        <button
          type="button"
          className="flex items-center gap-1.5 py-1 text-[11px] text-muted-foreground hover:text-foreground hover:underline"
        >
          <ChevronRight
            size={10}
            className={cn(
              "shrink-0 transition-transform",
              detailsOpen && "rotate-90",
            )}
          />
          查看子任务详情
        </button>
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div className="border-t border-border/30 pt-2 space-y-1.5">
          {loading && (
            <div className="flex items-center gap-2 py-2 text-[11px] text-muted-foreground">
              <Loader2 size={10} className="animate-spin text-muted-foreground" />
              加载中…
            </div>
          )}
          {error && (
            <div className="py-2 text-[11px] text-red-600 dark:text-red-500 flex items-center gap-2">
              <AlertTriangle size={10} />
              {error}
            </div>
          )}
          {!loading && !error && toolCalls && toolCalls.length === 0 && (
            <div className="py-2 text-[11px] text-muted-foreground">
              无工具调用记录
            </div>
          )}
          {!loading && !error && toolCalls && toolCalls.length > 0 && (
            <div className="space-y-1 max-h-96 overflow-y-auto">
              {toolCalls.map((tc, idx) => (
                <SubagentToolCallItem key={tc.id || idx} toolCall={tc} />
              ))}
            </div>
          )}
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}

function SubagentToolCallItem({ toolCall }: { toolCall: ToolCall }) {
  const [expanded, setExpanded] = useState(false);
  const args = toolCall.arguments as Record<string, unknown>;
  const argSummary =
    typeof args?.path === "string"
      ? args.path
      : typeof args?.command === "string"
        ? args.command
        : typeof args?.query === "string"
          ? args.query
          : typeof args?.url === "string"
            ? args.url
            : typeof args?.pattern === "string"
              ? args.pattern
              : null;
  const resultStr =
    toolCall.result != null
      ? typeof toolCall.result === "string"
        ? toolCall.result
        : JSON.stringify(toolCall.result, null, 2)
      : null;

  const isRead = toolCall.name.toLowerCase().includes("read");
  const title = (argSummary || args?.path || args?.title) as string | undefined;

  if (isRead && title) {
    const handleFileClick = () => {
      const ws = useWorkspaceStore.getState().workspacePath;
      const full = title.startsWith("/") ? title : `${ws || ""}/${title}`;
      useWorkspaceStore.getState().selectFile(full);
    };
    return (
      <div
        className="flex items-center gap-2 px-2 py-1 rounded bg-muted/30 text-[11px] cursor-pointer hover:bg-muted/50"
        onClick={handleFileClick}
        title={title}
      >
        <Eye size={10} className="shrink-0 text-muted-foreground" />
        <span className="font-mono truncate flex-1">{title.split("/").pop() || title}</span>
        <CheckCircle2 size={10} className="shrink-0 text-foreground/60" />
      </div>
    );
  }

  if (isCommandTool(toolCall.name)) {
    const command = getCommandText(args);
    const output = getToolCallOutputText(toolCall.result);
    const isWaitingForInput = isCommandToolLikelyWaitingForInput(toolCall);
    const cmdSummary = command ? (command.length > 80 ? `${command.slice(0, 80)}…` : command) : null;
    return (
      <Collapsible open={expanded} onOpenChange={setExpanded}>
        <div className="rounded border border-border/50 overflow-hidden">
          <CollapsibleTrigger asChild>
            <button
              type="button"
              className="w-full flex items-center gap-2 px-2 py-1.5 text-left text-[11px] bg-muted/20 hover:bg-muted/30"
            >
              <ChevronRight
                size={10}
                className={cn("shrink-0 transition-transform", expanded && "rotate-90")}
              />
              <span className="font-medium text-foreground/90">
                {formatToolName(toolCall.name)}
              </span>
              {cmdSummary && (
                <span className="truncate text-muted-foreground flex-1 font-mono">
                  {cmdSummary}
                </span>
              )}
              {isWaitingForInput ? (
                <span className="flex items-center gap-1 rounded bg-amber-100 px-1.5 py-0.5 text-[10px] text-amber-800 border border-amber-200">
                  <AlertTriangle size={10} />
                  Input needed
                </span>
              ) : output !== "" && (
                <span className="text-[10px] text-muted-foreground">
                  {toolCall.status === "completed" ? "✓" : toolCall.status === "failed" ? "✗" : "..."}
                </span>
              )}
            </button>
          </CollapsibleTrigger>
          <CollapsibleContent>
            <div className="border-t border-border/50 p-2 space-y-2 bg-muted/10">
              {isWaitingForInput && (
                <div className="flex items-start gap-2 rounded-md border border-amber-200 bg-amber-50 px-2 py-2 text-[11px] text-amber-900">
                  <AlertTriangle size={12} className="mt-0.5 shrink-0" />
                  <div>
                    <p className="font-medium">This command looks like it is waiting for terminal input.</p>
                    <p className="text-amber-800/90">
                      Prefer non-interactive flags like `--yes` or `-y`, or ask a question before continuing.
                    </p>
                  </div>
                </div>
              )}
              <div>
                <label className="text-[10px] text-muted-foreground">Command</label>
                <div className="mt-1 flex items-center gap-2 p-2 bg-bg-tertiary rounded-md text-xs font-mono">
                  <span className="text-accent-green">$</span>
                  <span className="break-all">{command || "(no command)"}</span>
                </div>
              </div>
              <div>
                <label className="text-[10px] text-muted-foreground">Output</label>
                <div className="mt-1 bg-[#1e1e1e] rounded-md overflow-hidden">
                  <div className="flex items-center gap-2 px-2 py-1 bg-bg-tertiary border-b border-border">
                    <Terminal size={10} className="text-text-muted" />
                    <span className="text-[10px] text-text-muted">Terminal</span>
                  </div>
                  <pre className="p-2 text-[10px] overflow-auto max-h-[300px] font-mono text-green-400 whitespace-pre-wrap break-words">
                    {output || "(no output)"}
                  </pre>
                </div>
              </div>
            </div>
          </CollapsibleContent>
        </div>
      </Collapsible>
    );
  }

  return (
    <Collapsible open={expanded} onOpenChange={setExpanded}>
      <div className="rounded border border-border/50 overflow-hidden">
        <CollapsibleTrigger asChild>
          <button
            type="button"
            className="w-full flex items-center gap-2 px-2 py-1.5 text-left text-[11px] bg-muted/20 hover:bg-muted/30"
          >
            <ChevronRight
              size={10}
              className={cn("shrink-0 transition-transform", expanded && "rotate-90")}
            />
            <span className="font-medium text-foreground/90">
              {formatToolName(toolCall.name)}
            </span>
            {argSummary && (
              <span className="truncate text-muted-foreground flex-1">
                {argSummary.length > 50 ? `${argSummary.slice(0, 50)}…` : argSummary}
              </span>
            )}
            {resultStr != null && (
              <span className="text-[10px] text-muted-foreground">
                {toolCall.status === "completed" ? "✓" : toolCall.status === "failed" ? "✗" : "..."}
              </span>
            )}
          </button>
        </CollapsibleTrigger>
        <CollapsibleContent>
          {resultStr ? (
            <div className="max-h-48 overflow-y-auto border-t border-border/50 p-2 bg-muted/10">
              <pre className="text-[10px] font-mono whitespace-pre-wrap break-words text-foreground/90 m-0">
                {resultStr}
              </pre>
            </div>
          ) : (
            <div className="p-2 text-[10px] text-muted-foreground">无返回值</div>
          )}
        </CollapsibleContent>
      </div>
    </Collapsible>
  );
}

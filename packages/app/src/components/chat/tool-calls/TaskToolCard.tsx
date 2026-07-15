import * as React from "react";
import { useTranslation } from "react-i18next";
import { ChevronDown } from "lucide-react";
import { cn } from "@/lib/utils";
import { entryFromPersistedSubagentSnapshot } from "@/lib/subagent-snapshot";
import { StreamingAgentBubble } from "@/components/chat/StreamingAgentBubble";
import { ToolCall, useSessionStore } from "@/stores/session";
import { useV2StreamingStore } from "@/stores/v2-streaming-store";
import { ToolCallStatusGlyph } from "./ToolCallStatusGlyph";

export function SkillToolCard({ toolCall }: { toolCall: ToolCall }) {
  const { t } = useTranslation();
  const args = toolCall.arguments as {
    name?: string;
  };
  const skillName = args?.name || t("chat.toolCall.skill.unknown", "unknown-skill");

  return (
    <div
      data-testid="tool-card-skill"
      className="overflow-hidden rounded-[14px] border border-[#e7edf4] bg-[#fbfcfe] dark:border-border dark:bg-card"
    >
      <div className="flex items-center gap-[10px] px-3 py-[10px]">
        <span className="text-[12px] text-[#8a7a63]">⚡</span>
        <span className="text-[13px] font-bold text-[#334155] dark:text-foreground">
          {skillName}
        </span>
        <span className="rounded-full border border-[#e8dfd1] bg-[#f7f4ed] px-2 py-0.5 text-[11px] text-[#8a7a63]">
          {t("chat.toolCall.skill.title", "Skill")}
        </span>
        <div className="ml-auto">
          <ToolCallStatusGlyph status={toolCall.status} />
        </div>
      </div>
    </div>
  );
}

export function RoleSkillToolCard({ toolCall }: { toolCall: ToolCall }) {
  const { t } = useTranslation();
  const args = toolCall.arguments as {
    name?: string;
  };
  const skillName = args?.name || t("chat.toolCall.roleSkill.unknown", "unknown-role-skill");

  return (
    <div
      data-testid="tool-row-role-skill"
      className="grid grid-cols-[18px_minmax(0,1fr)_48px] items-center gap-[10px] px-[10px] py-[6px]"
    >
      <span className="text-[12px] text-muted-foreground">⚡</span>
      <div className="min-w-0 text-[13px] text-[#334155] dark:text-slate-300">
        <strong className="font-semibold text-foreground">
          {t("chat.toolCall.roleSkill.title", "Role skill")}
        </strong>
        <span className="ml-2 font-mono text-foreground/85">{skillName}</span>
      </div>
      <div className="text-right">
        <ToolCallStatusGlyph status={toolCall.status} />
      </div>
    </div>
  );
}

export function TaskToolCard({ toolCall }: { toolCall: ToolCall }) {
  const { t } = useTranslation();
  const args = toolCall.arguments as {
    description?: string;
    subagent_type?: string;
    prompt?: string;
  };

  const description =
    args?.description || t("chat.toolCall.task.defaultDescription", "Subagent task");
  const subagentType = args?.subagent_type || "explorer";
  const prompt = args?.prompt?.trim() ?? "";
  const boundChildSessionId = useV2StreamingStore((s) => {
    for (const [childSid, toolId] of Object.entries(s.childAcpSessionToToolId)) {
      if (toolId === toolCall.id) return childSid;
    }
    return "";
  });
  const persistedChildSessionId = toolCall.metadata?.childAcpSessionId ?? "";

  const liveSubEntry = useV2StreamingStore((s) => s.subagentByToolId[toolCall.id]);
  const archivedSubEntry = useV2StreamingStore((s) => s.archivedSubagentByToolId[toolCall.id]);
  const persistedSubEntry = React.useMemo(
    () => entryFromPersistedSubagentSnapshot(toolCall.metadata?.subagentSnapshot),
    [toolCall.metadata?.subagentSnapshot],
  );
  const subEntry = liveSubEntry ?? archivedSubEntry ?? persistedSubEntry;
  const hasNestedStream = Boolean(subEntry);

  const permissionWaiting = useSessionStore((s) =>
    s.pendingPermissions.some(
      (entry) =>
        Boolean(entry.childSessionId) &&
        (entry.childSessionId === boundChildSessionId ||
          entry.childSessionId === persistedChildSessionId),
    ),
  );

  const isRunning = toolCall.status === "calling";
  const [expanded, setExpanded] = React.useState(isRunning);
  const [promptExpanded, setPromptExpanded] = React.useState(false);
  const nestedStreamRef = React.useRef<HTMLDivElement>(null);
  const stickToBottomRef = React.useRef(true);

  const scrollNestedStreamToBottom = React.useCallback((behavior: ScrollBehavior = "auto") => {
    const el = nestedStreamRef.current;
    if (!el) return;
    const targetTop = Math.max(0, el.scrollHeight - el.clientHeight);
    if (Math.abs(el.scrollTop - targetTop) < 2) return;
    el.scrollTo({ top: targetTop, behavior });
  }, []);

  React.useEffect(() => {
    if (isRunning) stickToBottomRef.current = true;
  }, [isRunning]);

  React.useEffect(() => {
    if (!expanded) setPromptExpanded(false);
  }, [expanded]);

  React.useEffect(() => {
    if (!expanded || !subEntry || !stickToBottomRef.current) return;
    const frame = requestAnimationFrame(() => scrollNestedStreamToBottom("auto"));
    return () => cancelAnimationFrame(frame);
  }, [
    expanded,
    subEntry?.lastUpdate,
    subEntry?.parts.length,
    subEntry?.outputText.length,
    subEntry?.thinkingText.length,
    subEntry?.toolCalls.length,
    scrollNestedStreamToBottom,
  ]);

  const handleNestedStreamScroll = React.useCallback(() => {
    const el = nestedStreamRef.current;
    if (!el) return;
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    stickToBottomRef.current = distanceFromBottom < 20;
  }, []);

  React.useEffect(() => {
    if (isRunning) {
      setExpanded((value) => (value ? value : true));
      return;
    }
    if (toolCall.status === "completed" || toolCall.status === "failed") {
      setExpanded((value) => (value ? false : value));
    }
  }, [isRunning, toolCall.status]);

  const waitingLabel = permissionWaiting
    ? t("chat.toolCall.task.waitingPermission", "Waiting for authorization")
    : null;

  const promptFolds = prompt.length > 96 || prompt.split("\n").length > 2;
  const promptTextClass =
    "text-[12.5px] leading-[1.6] text-ink-2 whitespace-pre-wrap break-words [overflow-wrap:anywhere]";

  return (
    <div
      data-testid="tool-card-task"
      className="overflow-hidden rounded-[14px] border border-border bg-paper dark:bg-card"
    >
      <button
        type="button"
        className="flex w-full items-start gap-[10px] px-[14px] py-3 text-left"
        onClick={() => setExpanded((value) => !value)}
        aria-expanded={expanded}
      >
        <ChevronDown
          className={cn(
            "mt-0.5 h-4 w-4 shrink-0 text-faint transition-transform",
            expanded ? "rotate-0" : "-rotate-90",
          )}
        />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-[13px] font-semibold text-foreground">
              {t("chat.toolCall.task.title", "Subagent")}
            </span>
            <span className="rounded-full border border-border px-2 py-0.5 text-[10.5px] text-muted-foreground">
              {subagentType}
            </span>
            <ToolCallStatusGlyph status={toolCall.status} />
          </div>
          <div className="mt-[3px] truncate text-[12px] leading-5 text-ink-2">
            {description}
          </div>
          {waitingLabel ? (
            <div className="mt-[3px] text-[11px] font-mono text-faint">
              {waitingLabel}
            </div>
          ) : null}
        </div>
      </button>

      {expanded && prompt ? (
        <div className="min-h-0 px-[14px] pb-[10px] pl-[40px]">
          {!promptFolds ? (
            <div className={promptTextClass} data-testid="task-prompt">
              {prompt}
            </div>
          ) : promptExpanded ? (
            <>
              <div
                className={cn(
                  promptTextClass,
                  "max-h-[120px] min-h-0 overflow-y-auto overscroll-contain",
                )}
                data-testid="task-prompt"
              >
                {prompt}
              </div>
              <button
                type="button"
                className="mt-1 text-[11px] text-faint hover:text-muted-foreground"
                onClick={() => setPromptExpanded(false)}
              >
                {t("chat.toolCall.task.collapsePrompt", "Show less")}
              </button>
            </>
          ) : (
            <button
              type="button"
              className={cn(
                promptTextClass,
                "relative block w-full max-h-[3.2em] overflow-hidden text-left after:pointer-events-none after:absolute after:inset-x-0 after:bottom-0 after:h-4 after:bg-gradient-to-t after:from-paper after:to-transparent dark:after:from-card",
              )}
              onClick={() => setPromptExpanded(true)}
              aria-expanded={false}
              data-testid="task-prompt"
            >
              {prompt}
            </button>
          )}
        </div>
      ) : null}

      {expanded && hasNestedStream && subEntry ? (
        <div
          ref={nestedStreamRef}
          className="max-h-[108px] overflow-y-auto overscroll-contain border-t border-border-soft px-[10px] py-2"
          data-testid="task-nested-stream"
          onScroll={handleNestedStreamScroll}
        >
          <StreamingAgentBubble entry={subEntry} variant="nested" />
        </div>
      ) : null}
    </div>
  );
}

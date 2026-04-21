import { useCallback } from "react";
import { cn } from "@/lib/utils";
import { ToolCall, useSessionStore } from "@/stores/session";

function StatusGlyph({ status }: { status: ToolCall["status"] }) {
  if (status === "completed") {
    return <span className="text-[13px] text-green-600 dark:text-green-400">✓</span>;
  }
  if (status === "failed") {
    return <span className="text-[13px] text-red-600 dark:text-red-400">✕</span>;
  }
  return <span className="text-[12px] text-muted-foreground">●</span>;
}

export function SkillToolCard({ toolCall }: { toolCall: ToolCall }) {
  const args = toolCall.arguments as {
    name?: string;
  };
  const skillName = args?.name || "unknown-skill";

  return (
    <div
      data-testid="tool-card-skill"
      className="overflow-hidden rounded-[14px] border border-[#e7edf4] bg-[#fbfcfe] dark:border-border dark:bg-card"
    >
      <div className="flex items-center gap-[10px] px-3 py-[10px]">
        <span className="text-[12px] text-[#8a7a63]">⚡</span>
        <span className="text-[13px] font-bold text-[#334155] dark:text-foreground">Skill</span>
        <span className="rounded-full border border-[#e8dfd1] bg-[#f7f4ed] px-2 py-0.5 text-[11px] text-[#8a7a63]">
          {skillName}
        </span>
        <div className="ml-auto">
          <StatusGlyph status={toolCall.status} />
        </div>
      </div>
    </div>
  );
}

export function RoleSkillToolCard({ toolCall }: { toolCall: ToolCall }) {
  const args = toolCall.arguments as {
    name?: string;
  };
  const skillName = args?.name || "unknown-role-skill";

  return (
    <div
      data-testid="tool-row-role-skill"
      className="grid grid-cols-[18px_minmax(0,1fr)_48px] items-center gap-[10px] px-[10px] py-[6px]"
    >
      <span className="text-[12px] text-muted-foreground">⚡</span>
      <div className="min-w-0 text-[13px] text-[#334155] dark:text-slate-300">
        <strong className="font-semibold text-foreground">Role skill</strong>
        <span className="ml-2 font-mono text-foreground/85">{skillName}</span>
      </div>
      <div className="text-right">
        <StatusGlyph status={toolCall.status} />
      </div>
    </div>
  );
}

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

  const description = args?.description || "Subagent task";
  const subagentType = args?.subagent_type || "explorer";
  const updateCount = toolCall.metadata?.summary?.length ?? 0;

  const openChildSession = useCallback(() => {
    if (sessionId) {
      useSessionStore.getState().setViewingChildSession(sessionId);
    }
  }, [sessionId]);

  const content = (
    <div className="flex items-center gap-[10px]">
      <div className="flex h-6 w-6 shrink-0 items-center justify-center rounded-[8px] border border-[#e5eaf0] bg-[#f8fafc] text-[12px] text-[#64748b] dark:border-border dark:bg-muted/20 dark:text-muted-foreground">
        ↗
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="text-[14px] font-bold text-[#1f2933] dark:text-foreground">Subagent</span>
          <span className="rounded-full border border-[#dbe4ea] px-2 py-0.5 text-[11px] text-[#475569] dark:border-border dark:text-foreground/80">
            {subagentType}
          </span>
          <StatusGlyph status={toolCall.status} />
        </div>
        <div className="mt-[3px] truncate text-[12px] leading-5 text-[#475569] dark:text-foreground/80">
          {description}
        </div>
        <div className="mt-[3px] text-[11px] text-[#94a3b8] dark:text-muted-foreground">
          opens child conversation{updateCount > 0 ? ` · ${updateCount} updates` : ""}
        </div>
      </div>
      {sessionId ? (
        <span className="shrink-0 pt-1 text-[12px] text-[#64748b] dark:text-muted-foreground">
          查看会话 →
        </span>
      ) : null}
    </div>
  );

  if (sessionId) {
    return (
      <button
        type="button"
        data-testid="tool-card-task"
        onClick={openChildSession}
        title="打开子会话"
        className={cn(
          "block w-full overflow-hidden rounded-[14px] border border-[#e7edf4] bg-[#fbfcfe] px-[14px] py-3 text-left dark:border-border dark:bg-card",
        )}
      >
        {content}
      </button>
    );
  }

  return (
    <div
      data-testid="tool-card-task"
      className="overflow-hidden rounded-[14px] border border-[#e7edf4] bg-[#fbfcfe] px-[14px] py-3 dark:border-border dark:bg-card"
    >
      {content}
    </div>
  );
}

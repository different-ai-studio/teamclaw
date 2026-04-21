import type { ToolCall } from "@/stores/session";

function getRoleName(toolCall: ToolCall, fallback: string): string {
  const args = toolCall.arguments as Record<string, unknown> | undefined;
  const rawName = args?.name ?? args?.role;
  return typeof rawName === "string" && rawName.trim() ? rawName.trim() : fallback;
}

function getLoadedSkillCount(result: unknown): number {
  if (typeof result !== "string") return 0;
  const match = result.match(/## Role Skills([\s\S]*)$/);
  if (!match) return 0;
  return match[1]
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => /^\d+\.\s+/.test(line)).length;
}

function getContextPreview(result: unknown): string | null {
  if (typeof result !== "string") return null;
  const descriptionMatch = result.match(/Description:\s*(.+)/);
  if (descriptionMatch?.[1]) return descriptionMatch[1].trim();
  const line = result
    .split("\n")
    .map((item) => item.trim())
    .find((item) => item && !item.startsWith("#"));
  return line || null;
}

function renderContextWithCodePill(context: string) {
  const tokenPattern = /([a-z0-9]+(?:[_-][a-z0-9]+){2,})/gi;
  const matches = Array.from(context.matchAll(tokenPattern));

  if (matches.length === 0) {
    return <span className="break-words">{context}</span>;
  }

  const firstMatch = matches[0];
  const matchText = firstMatch[0];
  const start = firstMatch.index ?? 0;
  const end = start + matchText.length;

  return (
    <span className="break-words">
      {context.slice(0, start)}
      <code className="rounded-md border border-[#e5eaf0] bg-[#f8fafc] px-[5px] py-[1px] text-[11px] text-[#334155] dark:border-border dark:bg-background dark:text-foreground/85">
        {matchText}
      </code>
      {context.slice(end)}
    </span>
  );
}

function StatusGlyph({ status }: { status: ToolCall["status"] }) {
  if (status === "completed") {
    return <span className="text-[13px] text-green-600 dark:text-green-400">✓</span>;
  }
  if (status === "failed") {
    return <span className="text-[13px] text-red-600 dark:text-red-400">✕</span>;
  }
  return <span className="text-[12px] text-muted-foreground">●</span>;
}

export function RoleLoadToolCard({ toolCall }: { toolCall: ToolCall }) {
  const roleName = getRoleName(toolCall, "unnamed-role");
  const skillCount = getLoadedSkillCount(toolCall.result);
  const context = getContextPreview(toolCall.result);

  let readyText = "role instructions ready";
  if (skillCount > 0) {
    readyText = `role instructions + ${skillCount} role skills`;
  }

  return (
    <div
      data-testid="tool-card-role-load"
      className="overflow-hidden rounded-[14px] border border-[#e7edf4] bg-[#fbfcfe] dark:border-border dark:bg-card"
    >
      <div className="flex items-center gap-[10px] border-b border-[#eef2f5] px-[14px] py-3 dark:border-border/60">
        <span className="text-[13px] text-muted-foreground">✦</span>
        <span className="text-[14px] font-bold text-[#1f2933] dark:text-foreground">Role Load</span>
        <span className="rounded-full border border-[#dbe4ea] px-2 py-0.5 text-[11px] text-[#475569] dark:border-border dark:text-foreground/80">
          {roleName}
        </span>
        <div className="ml-auto">
          <StatusGlyph status={toolCall.status} />
        </div>
      </div>

      <div className="grid grid-cols-[110px_1fr] gap-x-3 gap-y-2 px-[14px] py-3 text-[12px]">
        <div className="text-[#94a3b8] dark:text-muted-foreground">Ready</div>
        <div className="text-[#334155] dark:text-foreground/85">{readyText}</div>
        <div className="text-[#94a3b8] dark:text-muted-foreground">Context</div>
        <div className="min-w-0 text-[#334155] dark:text-foreground/85">
          {context ? (
            renderContextWithCodePill(context)
          ) : (
            <span className="text-muted-foreground">No additional context</span>
          )}
        </div>
      </div>
    </div>
  );
}

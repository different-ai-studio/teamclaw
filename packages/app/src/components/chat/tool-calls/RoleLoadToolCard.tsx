import { AlertTriangle, CheckCircle2, Loader2, UserRound } from "lucide-react";
import { useTranslation } from "react-i18next";
import { cn } from "@/lib/utils";
import type { ToolCall } from "@/stores/session";

type TranslateFn = ReturnType<typeof useTranslation>["t"];

function getRoleName(toolCall: ToolCall, fallback: string): string {
  const args = toolCall.arguments as Record<string, unknown> | undefined;
  const rawName = args?.name ?? args?.role;
  return typeof rawName === "string" && rawName.trim() ? rawName.trim() : fallback;
}

function getLoadedSkillCount(result: unknown): number | null {
  if (typeof result !== "string") return null;
  const match = result.match(/## Role Skills([\s\S]*)$/);
  if (!match) return null;
  const count = match[1]
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => /^\d+\.\s+/.test(line)).length;
  return count > 0 ? count : 0;
}

function getStatusCopy(
  toolCall: ToolCall,
  skillCount: number | null,
  t: TranslateFn,
) {
  if (toolCall.status === "failed") {
    return {
      badge: t("chat.tool.roleLoad.failedBadge", "Load failed"),
      badgeClass: "border-rose-200 bg-rose-50 text-rose-700",
      hint: t("chat.tool.roleLoad.failedHint", "Role instructions or role skill index could not be parsed"),
    };
  }

  if (toolCall.status === "completed") {
    return {
      badge: t("chat.tool.roleLoad.completedBadge", "Loaded"),
      badgeClass: "border-emerald-200 bg-emerald-50 text-emerald-700",
      hint:
        skillCount == null
          ? t("chat.tool.roleLoad.completedHintNoSkills", "Role instructions are ready in the current context")
          : t("chat.tool.roleLoad.completedHint", {
              count: skillCount,
              defaultValue: "Role instructions and {{count}} role skills are ready",
            }),
    };
  }

  return {
    badge: t("chat.tool.roleLoad.loadingBadge", "Loading"),
    badgeClass: "border-sky-200 bg-sky-50 text-sky-700",
    hint: t(
      "chat.tool.roleLoad.loadingHint",
      "Loading role instructions, routing hints, and role skill index",
    ),
  };
}

function getResultPreview(result: unknown): string | null {
  if (typeof result !== "string") return null;
  const lines = result
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => !line.startsWith("#") && !/^Description:/.test(line));
  return lines[0] ?? null;
}

export function RoleLoadToolCard({ toolCall }: { toolCall: ToolCall }) {
  const { t } = useTranslation();
  const roleName = getRoleName(toolCall, t("chat.tool.roleLoad.unnamedRole", "Unnamed role"));
  const skillCount = getLoadedSkillCount(toolCall.result);
  const status = getStatusCopy(toolCall, skillCount, t);
  const preview = getResultPreview(toolCall.result);
  const errorText =
    typeof toolCall.result === "string" && toolCall.status === "failed"
      ? toolCall.result
      : null;

  return (
    <div className="relative overflow-hidden rounded-lg border border-border bg-muted/50">
      {toolCall.status === "calling" ? (
        <div className="pointer-events-none absolute inset-0 bg-gradient-to-r from-transparent via-background/40 to-transparent opacity-60 animate-pulse" />
      ) : null}
      <div className="relative px-3 py-2.5">
        <div className="flex items-start gap-2.5">
          <div className="relative mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-md border border-border bg-background/90">
            <UserRound className="h-3.5 w-3.5 text-foreground/70" />
            {toolCall.status === "failed" ? (
              <span className="absolute -right-1 -bottom-1 flex h-4 w-4 items-center justify-center rounded-full border border-background bg-red-500 text-white">
                <AlertTriangle className="h-2.5 w-2.5" />
              </span>
            ) : toolCall.status === "completed" ? (
              <span className="absolute -right-1 -bottom-1 flex h-4 w-4 items-center justify-center rounded-full border border-background bg-emerald-500 text-white">
                <CheckCircle2 className="h-2.5 w-2.5" />
              </span>
            ) : (
              <span className="absolute -right-1 -bottom-1 flex h-4 w-4 items-center justify-center rounded-full border border-background bg-muted text-muted-foreground">
                <Loader2 className="h-2.5 w-2.5 animate-spin" />
              </span>
            )}
          </div>

          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-[13px] font-medium text-foreground">
                {t("chat.tool.roleLoad.title", "Role Load")}
              </span>
              <span
                className={cn(
                  "rounded-full border px-2 py-0.5 text-[10px]",
                  status.badgeClass,
                )}
              >
                {status.badge}
              </span>
              {toolCall.duration ? (
                <span className="text-[10px] text-muted-foreground">
                  {toolCall.duration < 1000
                    ? `${toolCall.duration}ms`
                    : `${(toolCall.duration / 1000).toFixed(1)}s`}
                </span>
              ) : null}
            </div>

            <div className="mt-1 flex items-center gap-2 text-sm text-foreground/80">
              <span className="rounded-full border border-border bg-background px-2 py-0.5 text-[10px] text-foreground/80">
                {roleName}
              </span>
              {toolCall.status === "calling" ? (
                <span className="inline-flex items-center gap-1 text-[10px] text-muted-foreground">
                  <Loader2 className="h-3 w-3 animate-spin" />
                  {t("chat.tool.roleLoad.assembling", "assembling role context")}
                </span>
              ) : null}
            </div>

            <p className="mt-1.5 text-[11px] leading-4.5 text-muted-foreground">
              {status.hint}
            </p>

            <div className="mt-2.5 overflow-hidden rounded-full bg-background/80 ring-1 ring-border/70">
              <div
                className={cn(
                  "h-0.5 rounded-full transition-all duration-500",
                  toolCall.status === "calling" && "w-2/3 animate-pulse bg-foreground/35",
                  toolCall.status === "completed" && "w-full bg-foreground/25",
                  toolCall.status === "failed" && "w-full bg-red-400/70",
                )}
              />
            </div>

            {toolCall.status === "completed" && (
              <div className="mt-2.5 flex items-center gap-1.5 min-w-0">
                {skillCount != null ? (
                  <span className="shrink-0 rounded-full border border-border bg-background px-2 py-0.5 text-[10px] text-muted-foreground">
                    {t("chat.tool.roleLoad.roleSkills", {
                      count: skillCount,
                      defaultValue: "role skills {{count}}",
                    })}
                  </span>
                ) : null}
                {preview ? (
                  <span
                    title={preview}
                    className="min-w-0 max-w-[min(100%,42rem)] truncate rounded-full border border-border bg-background px-2 py-0.5 text-[10px] text-muted-foreground"
                  >
                    {preview}
                  </span>
                ) : null}
              </div>
            )}

            {errorText ? (
              <div className="mt-2.5 rounded-md border border-red-200 bg-red-50/70 px-2.5 py-2 text-[11px] leading-4.5 text-red-700">
                {errorText}
              </div>
            ) : null}
          </div>
        </div>
      </div>
    </div>
  );
}

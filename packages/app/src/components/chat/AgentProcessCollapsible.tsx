import * as React from "react";
import { useTranslation } from "react-i18next";
import { ChevronRight, Loader2 } from "lucide-react";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { cn } from "@/lib/utils";

/** Quiet disclosure for completed-turn process (thinking + tools) above final text. */
export function AgentProcessCollapsible({
  children,
  summary,
  defaultOpen = false,
  className,
  loading = false,
  onOpenChange,
}: {
  children: React.ReactNode;
  summary?: string;
  defaultOpen?: boolean;
  className?: string;
  /** Async hydrate in progress — show spinner inside expanded panel. */
  loading?: boolean;
  onOpenChange?: (open: boolean) => void;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = React.useState(defaultOpen);

  const handleOpenChange = React.useCallback(
    (next: boolean) => {
      setOpen(next);
      onOpenChange?.(next);
    },
    [onOpenChange],
  );

  return (
    <div
      className={cn("mb-2", className)}
      data-testid="agent-process-collapsible"
      data-open={open ? "true" : "false"}
      data-loading={loading ? "true" : "false"}
    >
      <Collapsible open={open} onOpenChange={handleOpenChange}>
        <CollapsibleTrigger asChild>
          <button
            type="button"
            className="group/process inline-flex max-w-full cursor-pointer items-center gap-1.5 rounded py-0.5 text-left text-[12px] text-muted-foreground transition-colors hover:text-foreground"
          >
            <span className="font-medium">
              {t("chat.process", "处理过程")}
            </span>
            {summary ? (
              <>
                <span className="text-faint" aria-hidden>
                  ·
                </span>
                <span className="truncate font-mono text-[11px] text-faint">
                  {summary}
                </span>
              </>
            ) : null}
            <ChevronRight
              className={cn(
                "h-3 w-3 shrink-0 text-faint opacity-0 transition-[opacity,transform] duration-200 group-hover/process:opacity-100",
                open && "rotate-90",
              )}
              aria-hidden
            />
          </button>
        </CollapsibleTrigger>
        {open ? (
          <CollapsibleContent forceMount>
            <div className="mt-2 space-y-1 border-l border-border pl-[18px]">
              {loading ? (
                <div
                  className="flex items-center gap-2 py-1 text-[12px] text-muted-foreground"
                  data-testid="agent-process-loading"
                >
                  <Loader2 className="h-3.5 w-3.5 animate-spin text-faint" />
                  <span>{t("chat.processLoading", "加载处理过程…")}</span>
                </div>
              ) : (
                children
              )}
            </div>
          </CollapsibleContent>
        ) : null}
      </Collapsible>
    </div>
  );
}

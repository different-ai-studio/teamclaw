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
  loading = false,
  onOpenChange,
  className,
}: {
  children: React.ReactNode;
  summary?: string;
  defaultOpen?: boolean;
  loading?: boolean;
  onOpenChange?: (open: boolean) => void;
  className?: string;
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
            {loading ? (
              <Loader2 className="h-3 w-3 shrink-0 animate-spin text-faint" aria-hidden />
            ) : (
              <ChevronRight
                className={cn(
                  "h-3 w-3 shrink-0 text-faint opacity-0 transition-[opacity,transform] duration-200 group-hover/process:opacity-100",
                  open && "rotate-90",
                )}
                aria-hidden
              />
            )}
          </button>
        </CollapsibleTrigger>
        <CollapsibleContent>
          <div className="mt-2 space-y-1 border-l border-border pl-[18px]">
            {children}
          </div>
        </CollapsibleContent>
      </Collapsible>
    </div>
  );
}

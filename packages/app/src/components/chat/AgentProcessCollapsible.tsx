import * as React from "react";
import { useTranslation } from "react-i18next";
import { ChevronDown } from "lucide-react";
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
}: {
  children: React.ReactNode;
  summary?: string;
  defaultOpen?: boolean;
  className?: string;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = React.useState(defaultOpen);

  return (
    <div
      className={cn("mb-2", className)}
      data-testid="agent-process-collapsible"
      data-open={open ? "true" : "false"}
    >
      <Collapsible open={open} onOpenChange={setOpen}>
        <CollapsibleTrigger asChild>
          <button
            type="button"
            className="inline-flex max-w-full items-center gap-1.5 rounded py-0.5 text-left text-[12px] text-muted-foreground transition-colors hover:text-foreground"
          >
            <ChevronDown
              className={cn(
                "h-3 w-3 shrink-0 text-faint transition-transform duration-200",
                open && "rotate-180",
              )}
            />
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

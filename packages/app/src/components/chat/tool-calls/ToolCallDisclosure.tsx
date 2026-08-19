import * as React from "react";
import { ChevronRight } from "lucide-react";
import { cn } from "@/lib/utils";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";

type ToolCallDisclosureProps = {
  icon: React.ReactNode;
  title: React.ReactNode;
  target?: React.ReactNode;
  targetTitle?: string;
  onTargetClick?: () => void;
  meta?: React.ReactNode;
  status?: React.ReactNode;
  children?: React.ReactNode;
  defaultOpen?: boolean;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  testId?: string;
  contentTestId?: string;
  className?: string;
  contentClassName?: string;
};

export function ToolCallDisclosure({
  icon,
  title,
  target,
  targetTitle,
  onTargetClick,
  meta,
  status,
  children,
  defaultOpen = false,
  open: controlledOpen,
  onOpenChange,
  testId,
  contentTestId,
  className,
  contentClassName,
}: ToolCallDisclosureProps) {
  const [localOpen, setLocalOpen] = React.useState(defaultOpen);
  const open = controlledOpen ?? localOpen;
  const content = React.Children.toArray(children);
  const expandable = content.length > 0;

  const handleOpenChange = (nextOpen: boolean) => {
    if (controlledOpen === undefined) setLocalOpen(nextOpen);
    onOpenChange?.(nextOpen);
  };

  const header = (
    <div
      className={cn(
        "group grid min-h-9 w-full grid-cols-[18px_82px_minmax(0,1fr)_auto] items-center gap-2 px-[9px] py-1.5 text-left select-none",
        expandable && "cursor-pointer",
      )}
      onMouseDown={(event) => event.preventDefault()}
      onDragStart={(event) => event.preventDefault()}
    >
      <span className="relative flex h-[17px] w-[17px] items-center justify-center text-faint" aria-hidden="true">
        <span
          className={cn(
            "absolute inset-0 flex items-center justify-center transition-opacity duration-150",
            expandable && "group-hover:opacity-0",
          )}
        >
          {icon}
        </span>
        {expandable ? (
          <ChevronRight
            className={cn(
              "absolute h-[15px] w-[15px] opacity-0 transition-[opacity,transform] duration-150 group-hover:opacity-100",
              open && "rotate-90",
            )}
          />
        ) : null}
      </span>
      <span className="truncate text-[12.5px] font-semibold text-ink-2">{title}</span>
      {onTargetClick ? (
        <button
          type="button"
          className="min-w-0 truncate text-left font-mono text-[11.5px] text-muted-foreground underline decoration-faint/70 underline-offset-[3px]"
          title={targetTitle}
          onClick={(event) => {
            event.stopPropagation();
            onTargetClick();
          }}
        >
          {target}
        </button>
      ) : (
        <span className="min-w-0 truncate font-mono text-[11.5px] text-muted-foreground" title={targetTitle}>
          {target}
        </span>
      )}
      <span className="flex items-center justify-end gap-1.5 whitespace-nowrap font-mono text-[10.5px] text-faint">
        {meta}
        {status}
      </span>
    </div>
  );

  if (!expandable) {
    return (
      <div data-testid={testId} className={cn("w-full", className)}>
        {header}
      </div>
    );
  }

  return (
    <Collapsible open={open} onOpenChange={handleOpenChange}>
      <div
        data-testid={testId}
        data-state={open ? "open" : "closed"}
        className={cn(
          "w-full overflow-hidden rounded-[9px] border border-transparent bg-transparent",
          open && "border-border bg-paper",
          className,
        )}
      >
        <CollapsibleTrigger asChild>{header}</CollapsibleTrigger>
        <CollapsibleContent>
          <div
            data-testid={contentTestId}
            className={cn("w-full border-t border-border-soft bg-paper", contentClassName)}
          >
            {content}
          </div>
        </CollapsibleContent>
      </div>
    </Collapsible>
  );
}

import * as React from "react";
import { Loader2, Sparkles } from "lucide-react";
import { cn } from "@/lib/utils";
import type { AgentStreamEntry } from "@/stores/v2-streaming-store";

export function StreamingAgentBubble({
  entry,
  displayName,
}: {
  entry: AgentStreamEntry;
  displayName: string;
}) {
  const hasOutput = entry.outputText.length > 0;
  const hasThinking = entry.thinkingText.length > 0;
  return (
    <div className="flex items-start gap-2 px-4 py-3">
      <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground">
        <Sparkles className="h-4 w-4" />
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2 mb-1">
          <span className="text-sm font-medium">{displayName}</span>
          <Loader2 className="h-3 w-3 animate-spin text-muted-foreground" />
        </div>
        {hasThinking && (
          <div className="mb-2 rounded-md bg-muted/40 px-2 py-1 text-[12px] text-muted-foreground italic whitespace-pre-wrap break-words max-h-32 overflow-y-auto">
            {entry.thinkingText}
          </div>
        )}
        {hasOutput && (
          <div
            className={cn(
              "text-sm whitespace-pre-wrap break-words",
              !hasOutput && "text-muted-foreground italic",
            )}
          >
            {entry.outputText}
          </div>
        )}
        {!hasOutput && !hasThinking && (
          <div className="text-sm text-muted-foreground italic">Working...</div>
        )}
      </div>
    </div>
  );
}

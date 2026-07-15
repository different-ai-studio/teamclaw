import { cn } from "@/lib/utils";
import { useActorDisplayName, useAgentModelByActor } from "@/hooks/useActorDisplayName";

/** Subtle "actor name [· model]" label rendered above each message bubble.
 * Right-aligned for user messages, left-aligned for assistant. Skipped
 * when no senderActorId is available (legacy v1 messages). */
export function ActorLabel({
  senderActorId,
  modelOverride,
  isUser,
}: {
  senderActorId: string | undefined;
  modelOverride?: string | undefined;
  isUser: boolean;
}) {
  const name = useActorDisplayName(senderActorId);
  // Prefer the model captured on the message itself (historically accurate);
  // fall back to the runtime's live currentModel when the message predates
  // the model column or wasn't stamped.
  const liveModel = useAgentModelByActor(isUser ? null : senderActorId);
  const model = modelOverride || liveModel;
  if (!senderActorId || !name) return null;
  return (
    <div
      className={cn(
        "px-1 mb-0.5 text-[11px] text-muted-foreground/70",
        isUser ? "text-right" : "text-left",
      )}
    >
      <span>{name}</span>
      {!isUser && model && <span> · {model}</span>}
    </div>
  );
}

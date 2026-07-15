import { useSessionMessageStore } from "@/stores/session-message-store";
import { useActorsStore } from "@/stores/actors-store";

export function ActorMessageList() {
  const messages = useSessionMessageStore((s) => s.currentMessages());
  const actors = useActorsStore((s) => s.byId);

  if (messages.length === 0) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
        No messages yet
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-2 p-4 overflow-y-auto">
      {messages.map((m) => {
        const actor = actors[m.senderActorId];
        const name = actor?.displayName ?? m.senderActorId.slice(0, 8);
        return (
          <div key={m.messageId} className="flex flex-col gap-0.5">
            <div className="text-xs font-medium text-muted-foreground">{name}</div>
            <div className="whitespace-pre-wrap text-sm">{m.content}</div>
          </div>
        );
      })}
    </div>
  );
}

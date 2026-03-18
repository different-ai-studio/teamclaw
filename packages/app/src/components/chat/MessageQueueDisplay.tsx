import * as React from "react";
import { useTranslation } from "react-i18next";
import { Clock, ChevronUp, Trash2 } from "lucide-react";
import { type QueuedMessage } from "@/stores/session";

interface MessageQueueDisplayProps {
  queue: QueuedMessage[];
  onRemove: (id: string) => void;
}

export function MessageQueueDisplay({ queue, onRemove }: MessageQueueDisplayProps) {
  const { t } = useTranslation();
  const [isExpanded, setIsExpanded] = React.useState(false);

  if (queue.length === 0) return null;

  return (
    <div className="mb-2 rounded-xl border bg-card overflow-hidden">
      {/* Header */}
      <button
        onClick={() => setIsExpanded(!isExpanded)}
        className="w-full flex items-center justify-between px-4 py-2 hover:bg-muted/50 transition-colors"
      >
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Clock className="h-3.5 w-3.5" />
          <span>{t("chat.messagesQueued", "{{count}} messages queued", { count: queue.length })}</span>
        </div>
        <ChevronUp
          className={`h-4 w-4 text-muted-foreground transition-transform duration-200 ${
            isExpanded ? "" : "rotate-180"
          }`}
        />
      </button>

      {/* Queue items */}
      {isExpanded && (
        <div className="border-t max-h-32 overflow-y-auto">
          {queue.map((msg, index) => (
            <div
              key={msg.id}
              className="flex items-center justify-between px-4 py-2 border-b last:border-b-0 hover:bg-muted/30 transition-colors group"
            >
              <div className="flex items-center gap-3 flex-1 min-w-0">
                <span className="text-xs text-muted-foreground font-mono w-5">
                  #{index + 1}
                </span>
                <span className="text-sm truncate">{msg.content}</span>
              </div>
              <button
                onClick={() => onRemove(msg.id)}
                className="p-1.5 rounded-md text-muted-foreground opacity-0 group-hover:opacity-100 hover:text-destructive hover:bg-destructive/10 transition-all"
                title={t("common.remove", "Remove")}
              >
                <Trash2 className="h-3.5 w-3.5" />
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

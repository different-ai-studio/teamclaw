import type { SessionMessage } from "./session-types";

/**
 * Chronological order for the events inside one turn, ported from iOS
 * `StreamingDetailView.chronologicallySorted`.
 *
 * A turn is not text-then-tools: it interleaves reply text, thinking and tool
 * calls, and the daemon can deliver them out of order — live MQTT deltas race
 * the `requestTurnHistory` backfill. Sorting on arrival order would show a
 * tool call above the text that asked for it.
 *
 * iOS breaks ties on `sequence` then `id`; Expo's messages carry no sequence,
 * so the id is the only tiebreak. It is stable, which is what matters — the
 * list must not reshuffle between renders.
 */
export function sortTurnEvents(
  events: ReadonlyArray<SessionMessage>,
): SessionMessage[] {
  return [...events].sort((lhs, rhs) => {
    if (lhs.createdAt !== rhs.createdAt) {
      return lhs.createdAt < rhs.createdAt ? -1 : 1;
    }
    if (lhs.messageId === rhs.messageId) return 0;
    return lhs.messageId < rhs.messageId ? -1 : 1;
  });
}

/**
 * The model to caption the whole turn with.
 *
 * Walks backward for the most recent event that names one: tool and status
 * events are not model-attributable, so the newest reply or thinking event is
 * the authority. Null when nothing in the turn carries a model — a turn from
 * before the daemon stamped `current_model`, or one that only ran tools.
 */
export function turnModelName(
  events: ReadonlyArray<SessionMessage>,
): string | null {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const model = events[index]?.model?.trim();
    if (model) return model;
  }
  return null;
}

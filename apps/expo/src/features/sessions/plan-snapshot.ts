import type { SessionMessage } from "./session-types";

export type TodoItemStatus = "pending" | "in_progress" | "completed" | "cancelled";

export type TodoItem = {
  content: string;
  status: TodoItemStatus;
};

export type AgentPlanSnapshot = {
  agentId: string;
  agentName: string;
  text: string;
  items: TodoItem[];
};

/**
 * Parse the daemon's todo_update text payload into structured items.
 * Mirrors `parseTodoText` in `apps/ios/.../TodoItem.swift` line-for-line:
 *   - `[done] foo`       → completed
 *   - `[wip] foo`        → in_progress
 *   - `[todo] foo`       → pending
 *   - `[cancelled] foo`  → cancelled
 *   - lines without a recognized prefix become pending with the raw line
 *   - blank lines are skipped
 */
export function parseTodoText(text: string): TodoItem[] {
  const items: TodoItem[] = [];
  for (const rawLine of text.split(/\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    const lower = line.toLowerCase();
    if (lower.startsWith("[done]")) {
      items.push({
        content: line.slice("[done]".length).trim(),
        status: "completed",
      });
      continue;
    }
    if (lower.startsWith("[wip]")) {
      items.push({
        content: line.slice("[wip]".length).trim(),
        status: "in_progress",
      });
      continue;
    }
    if (lower.startsWith("[todo]")) {
      items.push({
        content: line.slice("[todo]".length).trim(),
        status: "pending",
      });
      continue;
    }
    if (lower.startsWith("[cancelled]")) {
      items.push({
        content: line.slice("[cancelled]".length).trim(),
        status: "cancelled",
      });
      continue;
    }
    items.push({ content: line, status: "pending" });
  }
  return items;
}

export function hasUnfinishedItems(items: TodoItem[]): boolean {
  return items.some(
    (item) => item.status === "pending" || item.status === "in_progress",
  );
}

/**
 * Build one plan snapshot per agent that still has unfinished items in its
 * latest plan_update message. Page order matches the agent's first
 * plan_update appearance in the stream — same stable ordering iOS uses.
 *
 * `agentNameFor` resolves a sender actor id → display name. If the lookup
 * fails the snapshot falls back to the raw actor id.
 */
export function deriveAgentPlanSnapshots(
  messages: ReadonlyArray<SessionMessage>,
  agentNameFor: (agentId: string) => string,
): AgentPlanSnapshot[] {
  const latestByAgent = new Map<string, SessionMessage>();
  const firstSeen = new Map<string, number>();
  messages.forEach((message, index) => {
    if (message.kind.trim().toLowerCase() !== "plan_update") return;
    const agentId = message.senderActorId;
    if (!agentId) return;
    latestByAgent.set(agentId, message);
    if (!firstSeen.has(agentId)) {
      firstSeen.set(agentId, index);
    }
  });

  const ordered = Array.from(latestByAgent.keys()).sort((a, b) => {
    const ai = firstSeen.get(a) ?? Number.MAX_SAFE_INTEGER;
    const bi = firstSeen.get(b) ?? Number.MAX_SAFE_INTEGER;
    return ai - bi;
  });

  const snapshots: AgentPlanSnapshot[] = [];
  for (const agentId of ordered) {
    const message = latestByAgent.get(agentId);
    if (!message) continue;
    const text = (message.content ?? "").trim();
    if (!text) continue;
    const items = parseTodoText(text);
    if (!hasUnfinishedItems(items)) continue;
    snapshots.push({
      agentId,
      agentName: agentNameFor(agentId) || agentId,
      text,
      items,
    });
  }
  return snapshots;
}

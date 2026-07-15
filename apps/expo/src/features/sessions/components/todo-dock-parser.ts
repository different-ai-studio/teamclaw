export type TodoItemStatus = "pending" | "in_progress" | "completed" | "cancelled";

export type TodoItem = {
  content: string;
  status: TodoItemStatus;
};

const PREFIX_TO_STATUS: ReadonlyArray<{ prefix: string; status: TodoItemStatus }> = [
  { prefix: "[done]", status: "completed" },
  { prefix: "[wip]", status: "in_progress" },
  { prefix: "[todo]", status: "pending" },
  { prefix: "[cancelled]", status: "cancelled" },
];

/**
 * Mirrors iOS `parseTodoText` in `TodoDockView.swift`. Splits the daemon's
 * todo_update payload by newline, trims each line, and tags it with a
 * status from a recognized `[done] / [wip] / [todo] / [cancelled]` prefix.
 * Lines without a prefix fall back to `pending`. Blank lines are skipped.
 */
export function parseTodoText(text: string): TodoItem[] {
  if (!text) return [];
  return text
    .split(/\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => {
      for (const { prefix, status } of PREFIX_TO_STATUS) {
        if (line.startsWith(prefix)) {
          return { content: line.slice(prefix.length).trim(), status };
        }
      }
      return { content: line, status: "pending" as const };
    });
}

export function countCompleted(items: ReadonlyArray<TodoItem>): number {
  let total = 0;
  for (const item of items) if (item.status === "completed") total += 1;
  return total;
}

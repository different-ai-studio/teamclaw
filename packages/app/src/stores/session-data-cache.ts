import type { Todo, FileDiff } from "@/lib/opencode/types";
import type { QueuedMessage } from "./session-types";

// Cache for session-specific data (todos, diff, and message queue)
// Shared across session action modules
export const sessionDataCache = new Map<
  string,
  { todos: Todo[]; diff: FileDiff[]; messageQueue?: QueuedMessage[] }
>();

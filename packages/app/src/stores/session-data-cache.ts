import type { Todo, FileDiff } from "@/lib/opencode/sdk-types";
import type { PendingQuestionState, QueuedMessage } from "./session-types";

// Pending questions cached per session
export type CachedPendingQuestion = PendingQuestionState;

// Cache for session-specific data (todos, diff, message queue, and pending questions)
// Shared across session action modules
export const sessionDataCache = new Map<
  string,
  { todos: Todo[]; diff: FileDiff[]; messageQueue?: QueuedMessage[]; pendingQuestions?: CachedPendingQuestion[] }
>();

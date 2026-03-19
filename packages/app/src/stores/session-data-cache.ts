import type { Todo, FileDiff, Question } from "@/lib/opencode/types";
import type { QueuedMessage } from "./session-types";

// Pending question data cached per session
export interface CachedPendingQuestion {
  questionId: string;
  toolCallId: string;
  messageId: string;
  questions: Question[];
}

// Cache for session-specific data (todos, diff, message queue, and pending questions)
// Shared across session action modules
export const sessionDataCache = new Map<
  string,
  { todos: Todo[]; diff: FileDiff[]; messageQueue?: QueuedMessage[]; pendingQuestion?: CachedPendingQuestion | null }
>();

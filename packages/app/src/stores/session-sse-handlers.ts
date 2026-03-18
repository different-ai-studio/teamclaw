/**
 * session-sse-handlers.ts — thin barrel that composes the three sub-modules.
 *
 * All handler logic has been extracted to:
 *   - session-sse-message-handlers.ts   (message streaming)
 *   - session-sse-tool-handlers.ts      (tool / todo / diff)
 *   - session-sse-lifecycle-handlers.ts  (lifecycle / session events)
 */
import type { SessionState } from "./session-types";
import { createMessageHandlers } from "./session-sse-message-handlers";
import { createToolHandlers } from "./session-sse-tool-handlers";
import { createLifecycleHandlers } from "./session-sse-lifecycle-handlers";

type SessionSet = (fn: ((state: SessionState) => Partial<SessionState>) | Partial<SessionState>) => void;
type SessionGet = () => SessionState;

export function createSSEHandlers(set: SessionSet, get: SessionGet) {
  return {
    ...createMessageHandlers(set, get),
    ...createToolHandlers(set, get),
    ...createLifecycleHandlers(set, get),
  };
}

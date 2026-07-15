/**
 * session-sse-handlers.ts — stub kept for module resolution.
 *
 * SSE handler sub-modules were removed during the v2 amuxd transition.
 * This file is retained until native Tauri-RPC event handling replaces it.
 */
import type { SessionState } from "./session-types";

type SessionSet = (fn: ((state: SessionState) => Partial<SessionState>) | Partial<SessionState>) => void;
type SessionGet = () => SessionState;

export function createSSEHandlers(_set: SessionSet, _get: SessionGet) {
  return {};
}
